import type { PdfRenderService } from '../../document-designer/rendering/pdf-render.service';
import { ResourcePlanningReportExportService } from './resource-planning-report-export.service';
import type { ResourcePlanningReport } from './resource-planning-report.types';

const report: ResourcePlanningReport = {
  range: {
    from: '2026-08-01',
    to: '2026-08-31',
    bucket: 'week',
    group_by: 'user',
  },
  rows: [
    {
      bucket_start: '2026-08-03',
      bucket_end: '2026-08-09',
      group_id: 'u1',
      group_name: '  =HYPERLINK("bad")<script>',
      group_type: 'user',
      currency: 'EUR',
      capacity_hours: 40,
      planned_hours: 20,
      actual_hours: 10,
      utilization_percent: 50,
      planned_labor_cost: 2000,
      actual_labor_cost: 1000,
      planned_non_labor_cost: 100,
      actual_non_labor_cost: 50,
      planned_total_cost: 2100,
      actual_total_cost: 1050,
      variance_hours: -10,
      variance_cost: -1050,
      over_allocated: false,
    },
  ],
  totals_by_currency: [
    {
      currency: 'EUR',
      capacity_hours: 40,
      planned_hours: 20,
      actual_hours: 10,
      utilization_percent: 50,
      planned_labor_cost: 2000,
      actual_labor_cost: 1000,
      planned_non_labor_cost: 100,
      actual_non_labor_cost: 50,
      planned_total_cost: 2100,
      actual_total_cost: 1050,
      variance_hours: -10,
      variance_cost: -1050,
      over_allocated: false,
    },
  ],
  exceptions: {
    ambiguous_time_entry_count: 0,
    unallocated_time_entry_count: 0,
    ambiguous_actual_hours: 0,
    unallocated_actual_hours: 0,
    missing_rate_hours: 0,
    undated_allocation_count: 0,
  },
};

describe('ResourcePlanningReportExportService', () => {
  it('escapes CSV fields and prevents spreadsheet formula injection', () => {
    const service = new ResourcePlanningReportExportService(
      {} as PdfRenderService,
    );

    const csv = service.toCsv(report);

    expect(csv).toContain('"\'  =HYPERLINK(""bad"")<script>"');
    expect(csv).toContain(',-10,-1050,false');
    expect(csv).toContain('\r\n');
  });

  it('escapes report values in self-contained PDF HTML', () => {
    const service = new ResourcePlanningReportExportService(
      {} as PdfRenderService,
    );

    const html = service.toHtml(report);

    expect(html).toContain('  =HYPERLINK(&quot;bad&quot;)&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('renders PDF with the existing bounded renderer', async () => {
    const pdf = Buffer.from('%PDF');
    const pdfService = {
      renderPdf: jest.fn().mockResolvedValue(pdf),
    } as unknown as jest.Mocked<PdfRenderService>;
    const service = new ResourcePlanningReportExportService(pdfService);

    await expect(service.toPdf(report)).resolves.toBe(pdf);
    expect(pdfService.renderPdf.mock.calls[0]).toEqual([
      expect.any(String),
      { widthPx: 1123, heightPx: 794 },
    ]);
  });

  it('appends a deduped Totals section to the CSV without disturbing the rows section', () => {
    const service = new ResourcePlanningReportExportService(
      {} as PdfRenderService,
    );

    const csv = service.toCsv(report);
    const [mainSection, totalsSection] = csv.split('\r\n\r\n');

    expect(mainSection).toContain('Bucket start,Bucket end,Group');
    expect(mainSection.split('\r\n')).toHaveLength(2); // header + 1 row
    expect(totalsSection).toContain('Totals');
    expect(totalsSection).toContain(
      'Currency,Capacity hours,Planned hours,Actual hours',
    );
    expect(totalsSection).toContain(
      'EUR,40,20,10,50,2000,1000,100,50,2100,1050,-10,-1050,false',
    );
  });

  it('appends a Totals table to the export HTML without disturbing the rows table', () => {
    const service = new ResourcePlanningReportExportService(
      {} as PdfRenderService,
    );

    const html = service.toHtml(report);

    expect(html).toContain('<h2>Totals</h2>');
    // Main rows table is still present and untouched.
    expect(html).toContain('  =HYPERLINK(&quot;bad&quot;)&lt;script&gt;');
    // Totals table renders the deduped total for the report's currency.
    const totalsIndex = html.indexOf('<h2>Totals</h2>');
    const exceptionsIndex = html.indexOf('<h2>Exceptions</h2>');
    const totalsHtml = html.slice(totalsIndex, exceptionsIndex);
    expect(totalsHtml).toContain('<td>EUR</td>');
    expect(totalsHtml).toContain('2,100');
  });

  it('rejects exports larger than the bounded row limit', () => {
    const service = new ResourcePlanningReportExportService(
      {} as PdfRenderService,
    );
    const oversized: ResourcePlanningReport = {
      ...report,
      rows: Array.from({ length: 10_001 }, () => report.rows[0]),
    };

    expect(() => service.toCsv(oversized)).toThrow('10,000 rows');
  });
});
