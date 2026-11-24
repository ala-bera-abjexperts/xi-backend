/**
 * @fileoverview Unit tests for AutomationTickService.withLinkedTasks (XE-T532):
 * a "Linked to" trigger filter gets the task's links added to the payload it is
 * matched against, without touching the original payload or querying when no
 * subscription needs it.
 *
 * @module src/automations/automation-tick.service.spec
 * @author Prince Jadiya
 */

import { AutomationTickService } from './automation-tick.service';
import * as taskLinks from '../tasks/task-links.util';

describe('AutomationTickService.withLinkedTasks', () => {
  const db = { from: jest.fn() };
  const service = new AutomationTickService(
    { getClient: () => db } as never,
    {} as never,
  );
  const call = (row: unknown, subs: unknown[]) =>
    (
      service as unknown as {
        withLinkedTasks: (
          r: unknown,
          s: unknown[],
        ) => Promise<Record<string, unknown>>;
      }
    ).withLinkedTasks(row, subs);
  const matches = (
    payload: Record<string, unknown>,
    filters: Record<string, unknown>,
    kind: string,
  ) =>
    (
      service as unknown as {
        matchesFilters: (
          p: Record<string, unknown>,
          f: Record<string, unknown>,
          k: string,
        ) => boolean;
      }
    ).matchesFilters(payload, filters, kind);

  const linkedFilter = {
    filter_query: {
      combinator: 'and',
      rules: [
        {
          combinator: 'or',
          rules: [{ field: 'linked_to', operator: 'in', value: 'xsd-t11' }],
        },
      ],
    },
  };

  let linkedIds: jest.SpyInstance;
  let taskKeys: jest.SpyInstance;

  beforeEach(() => {
    linkedIds = jest
      .spyOn(taskLinks, 'fetchLinkedTaskIds')
      .mockResolvedValue(new Map([['t10', new Set(['t11'])]]));
    taskKeys = jest
      .spyOn(taskLinks, 'fetchTaskKeys')
      .mockResolvedValue(new Map([['t11', 'XSD-T11']]));
  });

  afterEach(() => jest.restoreAllMocks());

  it('adds linked ids and keys for a nested-OR linked_to rule without mutating the payload', async () => {
    const payload = { task_id: 't10', task: { id: 't10', status: 'open' } };
    const row = {
      kind: 'app.task.updated',
      organization_id: 'org-1',
      payload,
    };

    const result = await call(row, [
      { filters: {} },
      { filters: linkedFilter },
    ]);

    expect(linkedIds).toHaveBeenCalledWith(db, 'org-1', ['t10']);
    expect(taskKeys).toHaveBeenCalledWith(db, 'org-1', ['t11']);
    expect(result).toEqual({ ...payload, linked_to: ['t11', 'XSD-T11'] });
    expect(payload).not.toHaveProperty('linked_to');
    expect(matches(result, linkedFilter, row.kind)).toBe(true);
    expect(matches(payload, linkedFilter, row.kind)).toBe(false);
  });

  it('falls back to payload.task.id', async () => {
    const row = {
      kind: 'app.task.created',
      organization_id: 'org-1',
      payload: { task: { id: 't10' } },
    };

    await call(row, [{ filters: linkedFilter }]);

    expect(linkedIds).toHaveBeenCalledWith(db, 'org-1', ['t10']);
  });

  it('returns the same payload reference and queries nothing without a linked_to rule', async () => {
    const payload = { task_id: 't10' };
    const row = { kind: 'app.task.updated', organization_id: 'org-1', payload };
    const other = {
      filter_query: {
        combinator: 'and',
        rules: [{ field: 'status', operator: 'eq', value: 'open' }],
      },
    };

    expect(await call(row, [{ filters: other }, {}])).toBe(payload);
    expect(linkedIds).not.toHaveBeenCalled();
    expect(taskKeys).not.toHaveBeenCalled();
  });

  it('does no lookup for app.process.* events', async () => {
    const payload = { process_id: 'p1' };
    const row = {
      kind: 'app.process.updated',
      organization_id: 'org-1',
      payload,
    };

    expect(await call(row, [{ filters: linkedFilter }])).toBe(payload);
    expect(linkedIds).not.toHaveBeenCalled();
  });
});
