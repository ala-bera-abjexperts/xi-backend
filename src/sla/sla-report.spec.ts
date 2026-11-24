import { normalizeSlaReport, SlaReportService } from './sla-report.service';

describe('SLA reporting boundary', () => {
  const config = {
    slaPreset: 'completed_pie',
    slaSpaceId: '11111111-1111-4111-8111-111111111111',
    slaMetricIds: [],
    slaTimezone: 'Asia/Kolkata',
    slaDateFrom: '2026-09-01',
    slaDateTo: '2026-09-30',
    slaBucket: 'day',
  };
  it('rejects invalid dates, range, timezone, presets, and pagination', () => {
    for (const patch of [
      { slaDateFrom: '2026-02-30' },
      { slaDateTo: '2026-08-01' },
      { slaTimezone: 'not/a-zone' },
      { slaPreset: 'all_tasks' },
    ])
      expect(() => normalizeSlaReport({ ...config, ...patch })).toThrow();
    expect(() => normalizeSlaReport(config, -1)).toThrow();
  });
  it('never reads aggregates before task and SLA access', async () => {
    const rpc = jest.fn();
    const service = new SlaReportService(
      { getClient: () => ({ rpc }) } as any,
      {
        authorizeSpace: jest.fn().mockRejectedValue(new Error('Denied')),
      } as any,
    );
    await expect(service.report('org', 'user', config)).rejects.toThrow(
      'Denied',
    );
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('SLA report owner names', () => {
  const config = {
    slaPreset: 'active_breached',
    slaSpaceId: '11111111-1111-4111-8111-111111111111',
    slaMetricIds: [],
    slaTimezone: 'UTC',
    slaDateFrom: '2026-09-01',
    slaDateTo: '2026-09-30',
  };
  it('enriches only the authorized page owner IDs with one lookup', async () => {
    const query: any = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      or: jest.fn().mockReturnThis(),
      in: jest.fn().mockReturnThis(),
      then: (resolve: any) =>
        Promise.resolve({
          data: [
            {
              id: 'u',
              first_name: 'Ada',
              last_name: 'Lovelace',
              email: 'ada@example.test',
            },
          ],
          error: null,
        }).then(resolve),
    };
    const db: any = {
      rpc: jest
        .fn()
        .mockResolvedValue({
          data: {
            rows: [{ owner: 'u' }, { owner: 'u' }, { owner: null }],
            total: 800,
          },
          error: null,
        }),
      from: jest.fn().mockReturnValue(query),
    };
    const access: any = {
      authorizeSpace: jest.fn().mockResolvedValue(undefined),
    };
    const result = await new SlaReportService(
      { getClient: () => db } as any,
      access,
    ).report('org', 'viewer', config);
    expect(access.authorizeSpace).toHaveBeenCalledTimes(2);
    expect(
      db.from.mock.calls.filter(([table]) => table === 'users'),
    ).toHaveLength(1);
    expect(query.in).toHaveBeenCalledWith('id', ['u']);
    expect(result.rows.map((row) => row.owner_name)).toEqual([
      'Ada Lovelace',
      'Ada Lovelace',
      null,
    ]);
    expect(result.total).toBe(800);
  });
});
