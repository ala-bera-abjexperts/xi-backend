import type { OrganizationModulesService } from '../../organization-modules/organization-modules.service';
import type { MigrationReportService } from '../services/migration-report.service';
import type { MigrationRunsService } from '../services/migration-runs.service';
import { MigrationRunsController } from './migration-runs.controller';

describe('MigrationRunsController report downloads', () => {
  const report = {
    runId: 'run-1',
    jobId: 'job-1',
    mode: 'live',
    status: 'succeeded',
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    unimplementedStages: [],
    entities: [],
    reconciliation: [],
    lossy: [],
    failures: [],
    totals: { created: 0, skipped: 0, failed: 0, blocked: 0 },
  };
  const bundle = { report, items: [] };
  const reportService = {
    getReport: jest.fn().mockResolvedValue(report),
    getExport: jest.fn().mockResolvedValue(bundle),
    listItems: jest.fn().mockResolvedValue({
      items: [],
      total: 0,
      limit: 100,
      offset: 0,
    }),
    toCsv: jest.fn().mockReturnValue('\uFEFFaudit csv'),
    toPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
  } as unknown as jest.Mocked<MigrationReportService>;
  const modules = {
    isEnabled: jest.fn().mockResolvedValue(true),
  } as unknown as jest.Mocked<OrganizationModulesService>;
  const controller = new MigrationRunsController(
    {} as MigrationRunsService,
    modules,
    reportService,
  );
  const user = { userId: 'user-1', organizationId: 'org-1' };

  beforeEach(() => jest.clearAllMocks());

  it('manually preserves the exact existing JSON success envelope', async () => {
    const response = responseMock();

    await controller.report(
      user as never,
      'run-1',
      { format: 'json' },
      response as never,
    );

    expect(response.json).toHaveBeenCalledWith({
      statusCode: 200,
      hasError: false,
      data: report,
      message: 'success',
    });
    expect(response.send).not.toHaveBeenCalled();
  });

  it.each([
    ['csv', 'text/csv; charset=utf-8', '\uFEFFaudit csv'],
    ['pdf', 'application/pdf', '%PDF'],
  ] as const)(
    'sends raw %s with hardened complete-file headers',
    async (format, mime, body) => {
      const response = responseMock();

      await controller.report(
        user as never,
        'run-1',
        { format },
        response as never,
      );

      const headers = response.set.mock.calls[0][0];
      expect(headers['Content-Type']).toBe(mime);
      expect(headers['Cache-Control']).toBe('no-store, private');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['Content-Disposition']).toContain(
        `migration-run-run-1.${format}`,
      );
      expect(headers['Content-Length']).toBe(String(Buffer.byteLength(body)));
      expect(Buffer.isBuffer(response.send.mock.calls[0][0])).toBe(true);
      expect(response.json).not.toHaveBeenCalled();
    },
  );

  it('writes no headers or partial bytes when PDF rendering fails', async () => {
    reportService.toPdf.mockRejectedValueOnce(new Error('render failed'));
    const response = responseMock();

    await expect(
      controller.report(
        user as never,
        'run-1',
        { format: 'pdf' },
        response as never,
      ),
    ).rejects.toThrow('render failed');
    expect(response.set).not.toHaveBeenCalled();
    expect(response.send).not.toHaveBeenCalled();
  });

  it('returns the paginated audit projection and tenant scope', async () => {
    const result = await controller.reportItems(user as never, 'run-1', {
      stage: 'issues',
      limit: 25,
      offset: 50,
    });

    expect(result).toEqual({ items: [], total: 0, limit: 100, offset: 0 });
    expect(reportService.listItems.mock.calls[0]).toEqual([
      'org-1',
      'run-1',
      { stage: 'issues', limit: 25, offset: 50 },
    ]);
  });
});

interface ResponseMock {
  status: jest.Mock<ResponseMock, [number]>;
  set: jest.Mock<ResponseMock, [Record<string, string>]>;
  json: jest.Mock<ResponseMock, [unknown]>;
  send: jest.Mock<ResponseMock, [unknown]>;
}

function responseMock(): ResponseMock {
  const response = {} as ResponseMock;
  response.status = jest.fn<ResponseMock, [number]>(() => response);
  response.set = jest.fn<ResponseMock, [Record<string, string>]>(
    () => response,
  );
  response.json = jest.fn<ResponseMock, [unknown]>(() => response);
  response.send = jest.fn<ResponseMock, [unknown]>(() => response);
  return response;
}
