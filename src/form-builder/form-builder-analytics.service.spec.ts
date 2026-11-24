import { BadRequestException, NotFoundException } from '@nestjs/common';
import { FormBuilderAnalyticsService } from './form-builder-analytics.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

const FORMS_TABLE = 'form_builder';
const SUBMISSIONS_TABLE = 'form_builder_submissions';
const FIELDS_TABLE = 'form_builder_fields';

type Resolved = Record<string, unknown>;
type Chain = Record<string, jest.Mock | ((...a: unknown[]) => unknown)>;

describe('FormBuilderAnalyticsService', () => {
  let service: FormBuilderAnalyticsService;
  let mockFrom: jest.Mock;

  const CTX = { spaceId: 'space-1', orgId: 'org-1' };

  function buildChain(resolved: Resolved): Chain {
    const chain: Chain = {};
    const self = () => chain;

    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.neq = jest.fn().mockImplementation(self);
    chain.gte = jest.fn().mockImplementation(self);
    chain.lte = jest.fn().mockImplementation(self);
    chain.in = jest.fn().mockImplementation(self);
    chain.contains = jest.fn().mockImplementation(self);
    chain.limit = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.update = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);

    return chain;
  }

  function useQueues(queues: Record<string, Chain[]>) {
    mockFrom.mockImplementation((table: string) => {
      const q = queues[table];

      if (!q || !q.length) throw new Error(`unexpected from(${table})`);

      return q.shift() as Chain;
    });
  }

  beforeEach(() => {
    mockFrom = jest.fn();

    const supabase = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    service = new FormBuilderAnalyticsService(supabase);
  });

  const liveFields = [
    {
      field_key: 'color',
      field_type: 'dropdown',
      label: 'Color',
      sort_order: 0,
    },
    {
      field_key: 'rating',
      field_type: 'rating',
      label: 'Rating',
      sort_order: 1,
    },
    {
      field_key: 'comment',
      field_type: 'long_text',
      label: 'Comment',
      sort_order: 2,
    },
    {
      field_key: 'subscribe',
      field_type: 'yes_no',
      label: 'Subscribe',
      sort_order: 3,
    },
    { field_key: 'sep', field_type: 'divider', label: 'Sep', sort_order: 4 },
  ];

  const rows = [
    {
      id: 's1',
      data: { color: 'red', rating: 5, comment: 'nice', subscribe: true },
      field_snapshot: [],
      created_at: '2026-06-01T10:00:00Z',
    },
    {
      id: 's2',
      data: { color: 'blue', rating: 3, comment: 'ok', subscribe: false },
      field_snapshot: [],
      created_at: '2026-06-02T10:00:00Z',
    },
  ];

  // ── getAnalytics happy path ────────────────────────────────────────────────

  it('aggregates submitted responses into metrics, trend and per-field buckets', async () => {
    useQueues({
      [FORMS_TABLE]: [buildChain({ data: { id: 'form-1' }, error: null })],
      [SUBMISSIONS_TABLE]: [
        buildChain({ count: 2, error: null }),
        buildChain({ data: rows, error: null }),
      ],
      [FIELDS_TABLE]: [buildChain({ data: liveFields, error: null })],
    });

    const result = await service.getAnalytics('form-1', CTX);

    expect(result.metrics).toEqual({
      total: 2,
      sampleSize: 2,
      truncated: false,
    });
    expect(result.trend).toEqual([
      { date: '2026-06-01', count: 1 },
      { date: '2026-06-02', count: 1 },
    ]);

    // divider is skipped → 4 charted fields
    expect(result.fields).toHaveLength(4);

    const byKey = Object.fromEntries(
      result.fields.map((f) => [f.field_key, f]),
    );

    expect(byKey.color.kind).toBe('choice');
    expect(byKey.color.responseCount).toBe(2);
    expect(byKey.color.buckets).toEqual(
      expect.arrayContaining([
        { name: 'red', value: 1 },
        { name: 'blue', value: 1 },
      ]),
    );

    expect(byKey.rating.kind).toBe('numeric');
    expect(byKey.rating.stats).toEqual({ count: 2, avg: 4, min: 3, max: 5 });
    expect(byKey.rating.buckets).toEqual([
      { name: '3', value: 1 },
      { name: '5', value: 1 },
    ]);

    expect(byKey.comment.kind).toBe('text');
    expect(byKey.comment.samples).toEqual(['nice', 'ok']);

    expect(byKey.subscribe.kind).toBe('boolean');
    expect(byKey.subscribe.buckets).toEqual(
      expect.arrayContaining([
        { name: 'Yes', value: 1 },
        { name: 'No', value: 1 },
      ]),
    );
  });

  it('flags truncated when the total count exceeds the loaded sample size', async () => {
    useQueues({
      [FORMS_TABLE]: [buildChain({ data: { id: 'form-1' }, error: null })],
      [SUBMISSIONS_TABLE]: [
        buildChain({ count: 5000, error: null }),
        buildChain({ data: rows, error: null }),
      ],
      [FIELDS_TABLE]: [buildChain({ data: liveFields, error: null })],
    });

    const result = await service.getAnalytics('form-1', CTX);

    expect(result.metrics.total).toBe(5000);
    expect(result.metrics.sampleSize).toBe(2);
    expect(result.metrics.truncated).toBe(true);
  });

  it('applies the created_at date range on both the count and load queries', async () => {
    const countChain = buildChain({ count: 2, error: null });
    const loadChain = buildChain({ data: rows, error: null });

    useQueues({
      [FORMS_TABLE]: [buildChain({ data: { id: 'form-1' }, error: null })],
      [SUBMISSIONS_TABLE]: [countChain, loadChain],
      [FIELDS_TABLE]: [buildChain({ data: liveFields, error: null })],
    });

    await service.getAnalytics('form-1', CTX, '2026-06-01', '2026-06-30');

    expect(countChain.gte).toHaveBeenCalledWith('created_at', '2026-06-01');
    expect(countChain.lte).toHaveBeenCalledWith('created_at', '2026-06-30');
    expect(loadChain.gte).toHaveBeenCalledWith('created_at', '2026-06-01');
    expect(loadChain.lte).toHaveBeenCalledWith('created_at', '2026-06-30');
    expect(loadChain.range).toHaveBeenCalledWith(0, 999);
  });

  it('supplements field metadata from submission snapshots for deleted fields', async () => {
    const rowsWithSnapshot = [
      {
        id: 's1',
        data: { deleted_field: 'legacy value' },
        field_snapshot: [
          {
            field_key: 'deleted_field',
            field_type: 'short_text',
            label: 'Old Question',
          },
        ],
        created_at: '2026-06-01T10:00:00Z',
      },
    ];

    useQueues({
      [FORMS_TABLE]: [buildChain({ data: { id: 'form-1' }, error: null })],
      [SUBMISSIONS_TABLE]: [
        buildChain({ count: 1, error: null }),
        buildChain({ data: rowsWithSnapshot, error: null }),
      ],
      // no live fields — everything comes from the snapshot
      [FIELDS_TABLE]: [buildChain({ data: [], error: null })],
    });

    const result = await service.getAnalytics('form-1', CTX);

    const field = result.fields.find((f) => f.field_key === 'deleted_field');

    expect(field).toBeDefined();
    expect(field?.label).toBe('Old Question');
    expect(field?.type).toBe('short_text');
    expect(field?.samples).toEqual(['legacy value']);
  });

  // ── edge cases ─────────────────────────────────────────────────────────────

  it('throws NotFound when the form does not exist', async () => {
    useQueues({
      [FORMS_TABLE]: [buildChain({ data: null, error: null })],
    });

    await expect(service.getAnalytics('missing', CTX)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('throws BadRequest when the form lookup errors', async () => {
    useQueues({
      [FORMS_TABLE]: [
        buildChain({ data: null, error: { message: 'db down' } }),
      ],
    });

    await expect(service.getAnalytics('form-1', CTX)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws BadRequest when the count query errors', async () => {
    useQueues({
      [FORMS_TABLE]: [buildChain({ data: { id: 'form-1' }, error: null })],
      [SUBMISSIONS_TABLE]: [
        buildChain({ count: null, error: { message: 'boom' } }),
      ],
    });

    await expect(service.getAnalytics('form-1', CTX)).rejects.toThrow(/boom/);
  });
});
