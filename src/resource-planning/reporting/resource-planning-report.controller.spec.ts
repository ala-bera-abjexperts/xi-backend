import type { ResourcePlanningReportExportService } from './resource-planning-report-export.service';
import type { ResourcePlanningReportService } from './resource-planning-report.service';
import { ResourcePlanningReportController } from './resource-planning-report.controller';
import type { ResourcePlanningReport } from './resource-planning-report.types';

const result: ResourcePlanningReport = {
  range: {
    from: '2026-08-01',
    to: '2026-08-31',
    bucket: 'week',
    group_by: 'user',
  },
  rows: [],
  totals_by_currency: [],
  exceptions: {
    ambiguous_time_entry_count: 0,
    unallocated_time_entry_count: 0,
    ambiguous_actual_hours: 0,
    unallocated_actual_hours: 0,
    missing_rate_hours: 0,
    undated_allocation_count: 0,
  },
};

describe('ResourcePlanningReportController', () => {
  const reportService = {
    getReport: jest.fn().mockResolvedValue(result),
  } as unknown as jest.Mocked<ResourcePlanningReportService>;
  const exportService = {
    toCsv: jest.fn().mockReturnValue('csv'),
    toPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
  } as unknown as jest.Mocked<ResourcePlanningReportExportService>;
  const controller = new ResourcePlanningReportController(
    reportService,
    exportService,
  );
  const user = { userId: 'u1', organizationId: 'org-1' };

  beforeEach(() => jest.clearAllMocks());

  it('returns the shared report envelope', async () => {
    await expect(
      controller.getReport(user as never, { bucket: 'week' }),
    ).resolves.toEqual({ data: result });
    expect(reportService.getReport.mock.calls[0]).toEqual([
      'org-1',
      {
        bucket: 'week',
      },
      'u1',
    ]);
  });

  it('streams CSV with fixed safe attachment headers', async () => {
    const response = { set: jest.fn(), send: jest.fn() };

    await controller.exportReport(
      user as never,
      { format: 'csv', from: '2026-08-01', to: '2026-08-31' },
      response as never,
    );

    expect(response.set).toHaveBeenCalledWith({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition':
        'attachment; filename="resource-planning-2026-08-01-to-2026-08-31.csv"',
    });
    expect(response.send).toHaveBeenCalledWith('csv');
    expect(reportService.getReport).toHaveBeenCalledWith(
      'org-1',
      { from: '2026-08-01', to: '2026-08-31' },
      'u1',
    );
  });

  it('streams PDF without converting the buffer to text', async () => {
    const response = { set: jest.fn(), send: jest.fn() };

    await controller.exportReport(
      user as never,
      { format: 'pdf', from: '2026-08-01', to: '2026-08-31' },
      response as never,
    );

    const headerCalls = response.set.mock.calls as unknown as Array<
      [Record<string, string>]
    >;
    const headers = headerCalls[0][0];
    expect(headers['Content-Type']).toBe('application/pdf');
    expect(headers['Content-Disposition']).toMatch(/\.pdf"$/);
    expect(response.send).toHaveBeenCalledWith(Buffer.from('%PDF'));
  });

  it('passes space_id through to the report for both the view and the export', async () => {
    const response = { set: jest.fn(), send: jest.fn() };
    const space_id = '11111111-1111-4111-8111-111111111111';

    await controller.getReport(user as never, { space_id });
    await controller.exportReport(
      user as never,
      { format: 'csv', space_id },
      response as never,
    );

    expect(reportService.getReport.mock.calls).toEqual([
      ['org-1', { space_id }, 'u1'],
      ['org-1', { space_id }, 'u1'],
    ]);
  });
});
