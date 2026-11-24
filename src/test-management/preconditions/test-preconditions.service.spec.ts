import type { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import type { TestManagementAccessService } from '../access/test-management-access.service';
import { TestPreconditionsService } from './test-preconditions.service';

const ORG = 'org-1';
const SPACE = 'space-1';
const PRECONDITION = 'pre-1';

interface Resolved {
  data: unknown;
  error: { code?: string; message: string } | null;
  count?: number | null;
  status?: number;
}

type Chain = Record<string, jest.Mock> & PromiseLike<Resolved>;

function buildChain(resolved: Resolved): Chain {
  const chain = {} as Chain;

  for (const name of [
    'select',
    'eq',
    'in',
    'or',
    'contains',
    'order',
    'range',
  ]) {
    chain[name] = jest.fn(() => chain);
  }

  chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
  Object.assign(chain, {
    then: (onFulfilled: (value: Resolved) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled),
  });

  return chain;
}

function firstArg(mock: jest.Mock): unknown {
  return (mock.mock.calls as unknown[][])[0]?.[0];
}

describe('TestPreconditionsService', () => {
  let service: TestPreconditionsService;
  let from: jest.Mock;

  beforeEach(() => {
    from = jest.fn();
    service = new TestPreconditionsService(
      { getClient: () => ({ from }) } as unknown as SupabaseAdminService,
      {
        assertAvailable: jest.fn().mockResolvedValue(undefined),
      } as unknown as TestManagementAccessService,
      {} as AuditLogsService,
    );
  });

  describe('listCases', () => {
    // The first query proves the precondition is in the space, the second is the page.
    const casesPage = (
      page: Resolved = { data: [], error: null, count: 0 },
    ) => {
      const load = buildChain({ data: { id: PRECONDITION }, error: null });
      const rows = buildChain(page);

      from.mockReturnValueOnce(load).mockReturnValueOnce(rows);

      return rows;
    };

    it('lists the cases with key and title from their tickets, in the added order', async () => {
      const rows = casesPage({
        data: [
          {
            id: 'c1',
            test_type: 'manual',
            readiness: 'ready',
            is_archived: false,
            task: { key: 'P-T3', summary: 'Login' },
          },
        ],
        error: null,
        count: 1,
      });

      const result = await service.listCases(ORG, SPACE, PRECONDITION, {});

      expect(rows.contains).toHaveBeenCalledWith('precondition_ids', [
        PRECONDITION,
      ]);
      expect(rows.in).not.toHaveBeenCalled();
      expect(rows.or).not.toHaveBeenCalled();
      expect(rows.order).toHaveBeenNthCalledWith(1, 'created_at', {
        ascending: true,
      });
      expect(rows.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
      expect(result).toEqual({
        items: [
          {
            id: 'c1',
            test_type: 'manual',
            readiness: 'ready',
            is_archived: false,
            key: 'P-T3',
            task_key: 'P-T3',
            title: 'Login',
          },
        ],
        total: 1,
        page: 1,
        pageSize: 50,
      });
    });

    it('filters by search, readiness and test type', async () => {
      const rows = casesPage();

      await service.listCases(ORG, SPACE, PRECONDITION, {
        q: 'sign in',
        readiness: ['draft', 'deprecated'],
        testType: 'cucumber',
      });

      expect(rows.or).toHaveBeenCalledWith(
        'key.ilike."%sign in%",summary.ilike."%sign in%"',
        { referencedTable: 'task' },
      );
      expect(rows.in).toHaveBeenCalledWith('readiness', [
        'draft',
        'deprecated',
      ]);
      expect(rows.eq).toHaveBeenCalledWith('test_type', 'cucumber');
    });

    it.each([
      ['key', 'created_at', true],
      ['key:desc', 'created_at', false],
      ['title', 'task(summary)', true],
      ['title:desc', 'task(summary)', false],
      ['test_type', 'test_type', true],
      ['test_type:desc', 'test_type', false],
      ['readiness', 'readiness', true],
      ['readiness:desc', 'readiness', false],
    ])('sorts by %s', async (sort, column, ascending) => {
      const rows = casesPage();

      await service.listCases(ORG, SPACE, PRECONDITION, { sort });

      expect(rows.order).toHaveBeenNthCalledWith(1, column, { ascending });
      expect(rows.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true });
    });

    it('counts a page past the end with the same filters', async () => {
      casesPage({
        data: null,
        error: { code: 'PGRST103', message: 'range' },
      });

      const count = buildChain({ data: null, error: null, count: 2 });

      from.mockReturnValueOnce(count);

      const result = await service.listCases(ORG, SPACE, PRECONDITION, {
        page: 4,
        pageSize: 10,
        readiness: ['ready'],
      });

      expect(firstArg(count.select)).toContain(
        'task:tasks!test_cases_task_id_fkey!inner(key)',
      );
      expect(count.in).toHaveBeenCalledWith('readiness', ['ready']);
      expect(result).toEqual({ items: [], total: 2, page: 4, pageSize: 10 });
    });
  });
});
