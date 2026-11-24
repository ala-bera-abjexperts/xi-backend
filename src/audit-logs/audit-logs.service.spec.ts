/**
 * @fileoverview Unit tests for AuditLogsService — createLog, logAction (silent),
 * paginated getLogs, getRecentActivity, getAuditStatistics aggregation.
 * @module src/audit-logs/audit-logs.service.spec
 * @author Prince Jadiya
 */

import { AuditLogsService } from './audit-logs.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';

describe('AuditLogsService', () => {
  let service: AuditLogsService;
  let mockFrom: jest.Mock;

  const ORG = 'org-1';
  const USER = 'user-1';

  function buildChain(resolved: {
    data: unknown;
    error: unknown;
    count?: number;
  }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.gte = jest.fn().mockImplementation(self);
    chain.lte = jest.fn().mockImplementation(self);
    chain.is = jest.fn().mockImplementation(self);
    chain.order = jest.fn().mockImplementation(self);
    chain.range = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    service = new AuditLogsService(supa);
  });

  // ── createLog ──────────────────────────────────────────────────────────

  describe('createLog', () => {
    it('inserts an audit log row', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await service.createLog(ORG, USER, {
        entity_type: 'space',
        entity_id: 'space-1',
        action: 'create',
        changes: { name: 'New space' },
      });

      expect(mockFrom).toHaveBeenCalledWith('audit_logs');
      expect(chain.insert).toHaveBeenCalled();
    });

    it('swallows DB errors so audit failures never break callers', async () => {
      const chain = buildChain({
        data: null,
        error: { message: 'connection refused' },
      });
      mockFrom.mockReturnValue(chain);

      await expect(
        service.createLog(ORG, USER, {
          entity_type: 'space',
          action: 'create',
        }),
      ).resolves.toBeUndefined();
    });

    it('passes nulls for optional fields', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await service.createLog(ORG, USER, {
        entity_type: 'task',
        action: 'delete',
      });

      const insertedRow = (
        (chain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { entity_id: unknown; changes: unknown };
      expect(insertedRow.entity_id).toBeNull();
      expect(insertedRow.changes).toBeNull();
    });
  });

  // ── logAction ──────────────────────────────────────────────────────────

  describe('logAction', () => {
    it('delegates to createLog with the supplied entity + action', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await service.logAction(ORG, USER, 'task', 'task-1', 'update', {
        title: 'New' as unknown,
      });

      const inserted = (
        (chain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { entity_type: string; entity_id: string; action: string };
      expect(inserted.entity_type).toBe('task');
      expect(inserted.entity_id).toBe('task-1');
      expect(inserted.action).toBe('update');
    });

    it('never throws — even when downstream DB errors', async () => {
      const chain = buildChain({
        data: null,
        error: { message: 'boom' },
      });
      mockFrom.mockReturnValue(chain);

      await expect(
        service.logAction(ORG, USER, 'task', 'task-1', 'delete'),
      ).resolves.toBeUndefined();
    });

    it("accepts 'workflow.transition.executed' and stores it as the action", async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await service.logAction(
        ORG,
        USER,
        'task',
        'task-42',
        'workflow.transition.executed',
        {
          from_node_id: 'node-todo',
          to_node_id: 'node-doing',
          transition_id: 'tr-1',
        },
      );

      const inserted = (
        (chain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as {
        entity_type: string;
        entity_id: string;
        action: string;
        changes: unknown;
      };
      expect(inserted.entity_type).toBe('task');
      expect(inserted.entity_id).toBe('task-42');
      expect(inserted.action).toBe('workflow.transition.executed');
      expect(inserted.changes).toEqual({
        from_node_id: 'node-todo',
        to_node_id: 'node-doing',
        transition_id: 'tr-1',
      });
    });

    it("H5 — logSystemAction also accepts 'workflow.transition.executed'", async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);

      await service.logSystemAction(
        ORG,
        'task',
        'task-43',
        'workflow.transition.executed',
        { transition_id: 'tr-2' },
      );

      const inserted = (
        (chain.insert as jest.Mock).mock.calls as unknown[][]
      )[0]?.[0] as { entity_id: string; action: string; user_id: unknown };

      expect(inserted.entity_id).toBe('task-43');
      expect(inserted.action).toBe('workflow.transition.executed');
      // system action has no user_id
      expect(inserted.user_id).toBeNull();
    });
  });

  // ── getLogs ────────────────────────────────────────────────────────────

  describe('getLogs', () => {
    it('returns paginated logs with default page size of 50', async () => {
      const rows = [
        {
          id: 'log-1',
          organization_id: ORG,
          user_id: USER,
          entity_type: 'space',
          entity_id: 'space-1',
          action: 'create',
          changes: null,
          created_at: '2025-01-01T00:00:00Z',
          user: null,
        },
      ];
      const chain = buildChain({ data: rows, error: null, count: 1 });
      mockFrom.mockReturnValue(chain);

      const r = await service.getLogs(ORG, {});

      expect(r.data).toHaveLength(1);
      expect(r.total).toBe(1);
      expect(r.pageSize).toBe(50);
      expect(r.page).toBe(1);
      expect(r.hasMore).toBe(false);
    });

    it('caps page size at 100', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);

      const r = await service.getLogs(ORG, { limit: '500', offset: '0' });

      expect(r.pageSize).toBe(100);
    });

    it('coerces invalid limit/offset to safe defaults', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);

      const r = await service.getLogs(ORG, { limit: 'abc', offset: '-9' });

      expect(r.pageSize).toBe(50);
      expect(r.page).toBe(1);
    });

    it('applies entity_type/action/user/date filters when provided', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);

      await service.getLogs(ORG, {
        entity_type: 'task',
        entity_id: 'task-1',
        action: 'update',
        user_id: USER,
        start_date: '2025-01-01',
        end_date: '2025-12-31',
      });

      const eqCalls = (
        (chain.eq as jest.Mock).mock.calls as [string, unknown][]
      ).map((c) => c[0]);
      expect(eqCalls).toEqual(
        expect.arrayContaining([
          'organization_id',
          'entity_type',
          'entity_id',
          'action',
          'user_id',
        ]),
      );
      expect(chain.gte).toHaveBeenCalledWith('created_at', '2025-01-01');
      expect(chain.lte).toHaveBeenCalledWith('created_at', '2025-12-31');
    });

    it('throws when the underlying query errors', async () => {
      const chain = buildChain({
        data: null,
        error: { message: 'db down' },
        count: 0,
      });
      mockFrom.mockReturnValue(chain);

      await expect(service.getLogs(ORG, {})).rejects.toThrow('db down');
    });

    it('flags hasMore=true when there are more rows beyond the current page', async () => {
      const chain = buildChain({ data: [], error: null, count: 200 });
      mockFrom.mockReturnValue(chain);

      const r = await service.getLogs(ORG, { limit: '50', offset: '0' });
      expect(r.hasMore).toBe(true);
    });
  });

  // ── getRecentActivity ──────────────────────────────────────────────────

  describe('getRecentActivity', () => {
    it('returns the unwrapped data array', async () => {
      const rows = [
        { id: 'log-1', action: 'create', entity_type: 'space', user_id: USER },
      ];
      const chain = buildChain({ data: rows, error: null, count: 1 });
      mockFrom.mockReturnValue(chain);

      const r = await service.getRecentActivity(ORG, 5);

      expect(Array.isArray(r)).toBe(true);
      expect(r).toHaveLength(1);
    });

    it('caps the limit at 100', async () => {
      const chain = buildChain({ data: [], error: null, count: 0 });
      mockFrom.mockReturnValue(chain);

      await service.getRecentActivity(ORG, 9999);
      expect(chain.range).toHaveBeenCalledWith(0, 99);
    });
  });

  // ── getAuditStatistics ─────────────────────────────────────────────────

  describe('getAuditStatistics', () => {
    it('aggregates byAction / byEntityType / byUser counts', async () => {
      const rows = [
        {
          id: 'log-1',
          action: 'create',
          entity_type: 'space',
          user_id: 'u-1',
        },
        {
          id: 'log-2',
          action: 'create',
          entity_type: 'task',
          user_id: 'u-1',
        },
        {
          id: 'log-3',
          action: 'delete',
          entity_type: 'space',
          user_id: 'u-2',
        },
      ];
      const chain = buildChain({ data: rows, error: null, count: 3 });
      mockFrom.mockReturnValue(chain);

      const stats = await service.getAuditStatistics(ORG);

      expect(stats.total).toBe(3);
      expect(stats.byAction).toEqual({ create: 2, delete: 1 });
      expect(stats.byEntityType).toEqual({ space: 2, task: 1 });
      expect(stats.byUser).toEqual({ 'u-1': 2, 'u-2': 1 });
    });

    it('skips rows with null user_id when bucketing byUser', async () => {
      const rows = [
        { id: 'l-1', action: 'create', entity_type: 'space', user_id: null },
        { id: 'l-2', action: 'update', entity_type: 'space', user_id: 'u-1' },
      ];
      const chain = buildChain({ data: rows, error: null, count: 2 });
      mockFrom.mockReturnValue(chain);

      const stats = await service.getAuditStatistics(ORG);

      expect(stats.byUser).toEqual({ 'u-1': 1 });
    });
  });

  // ── PERF: exact-count opt-out ──────────────────────────────────────────
  // `count: 'exact'` costs an unbounded aggregate over every matching row.
  // Callers that only read `data` must not pay for it.

  describe('getLogs — withCount', () => {
    /** Second arg of the `.select()` call — the PostgREST count option. */
    const selectOptions = (chain: Record<string, unknown>): unknown =>
      ((chain.select as jest.Mock).mock.calls[0] as unknown[])[1];

    it('requests an exact count by default (unchanged behaviour)', async () => {
      const chain = buildChain({ data: [], error: null, count: 7 });
      mockFrom.mockReturnValue(chain);

      const res = await service.getLogs(ORG, {});

      expect(selectOptions(chain)).toEqual({ count: 'exact' });
      expect(res.total).toBe(7);
    });

    it('omits the count entirely when withCount is false', async () => {
      const chain = buildChain({ data: [], error: null });
      mockFrom.mockReturnValue(chain);

      await service.getLogs(ORG, {}, { withCount: false });

      expect(selectOptions(chain)).toBeUndefined();
    });

    it('falls back to the page length instead of a misleading total of 0', async () => {
      const rows = [{ id: 'l-1' }, { id: 'l-2' }];
      const chain = buildChain({ data: rows, error: null });
      mockFrom.mockReturnValue(chain);

      const res = await service.getLogs(ORG, {}, { withCount: false });

      expect(res.total).toBe(2);
      // 2 rows against the default page size of 50 → not a full page.
      expect(res.hasMore).toBe(false);
    });

    it('reports hasMore when the page came back full and no count was taken', async () => {
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: `l-${i}` }));
      const chain = buildChain({ data: rows, error: null });
      mockFrom.mockReturnValue(chain);

      const res = await service.getLogs(
        ORG,
        { limit: '10' },
        { withCount: false },
      );

      expect(res.hasMore).toBe(true);
    });

    it('getRecentActivity skips the count and still returns the same rows', async () => {
      const rows = [{ id: 'l-1' }, { id: 'l-2' }];
      const chain = buildChain({ data: rows, error: null });
      mockFrom.mockReturnValue(chain);

      const result = await service.getRecentActivity(ORG, 20);

      expect(selectOptions(chain)).toBeUndefined();
      expect(result).toEqual(rows);
    });

    it('getAuditStatistics skips the count and aggregates identically', async () => {
      const rows = [
        { id: 'l-1', action: 'create', entity_type: 'space', user_id: 'u-1' },
        { id: 'l-2', action: 'create', entity_type: 'task', user_id: 'u-1' },
      ];
      const chain = buildChain({ data: rows, error: null });
      mockFrom.mockReturnValue(chain);

      const stats = await service.getAuditStatistics(ORG);

      expect(selectOptions(chain)).toBeUndefined();
      // `total` has always come from data.length here, never from the count.
      expect(stats.total).toBe(2);
      expect(stats.byAction).toEqual({ create: 2 });
      expect(stats.byEntityType).toEqual({ space: 1, task: 1 });
    });
  });
});
