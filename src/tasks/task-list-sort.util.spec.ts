import {
  applyTaskListOrder,
  resolveTaskSortColumn,
} from './task-list-sort.util';

type OrderCall = [string, { ascending: boolean; nullsFirst?: boolean }];

function fakeQuery() {
  const calls: OrderCall[] = [];
  const query = {
    calls,
    order(column: string, options: OrderCall[1]) {
      calls.push([column, options]);
      return query;
    },
  };
  return query;
}

describe('task list sort (XE-T519)', () => {
  it('keeps the manual order when no sort is requested', () => {
    const q = fakeQuery();
    applyTaskListOrder(q);
    expect(q.calls).toEqual([
      ['sort_order', { ascending: true }],
      ['created_at', { ascending: false }],
    ]);
  });

  it('sorts server-side by the column, empties last, with an id tie-breaker', () => {
    const q = fakeQuery();
    applyTaskListOrder(q, 'status', 'desc');
    expect(q.calls).toEqual([
      ['status', { ascending: false, nullsFirst: false }],
      ['id', { ascending: true }],
    ]);
  });

  it('defaults to ascending for anything but "desc"', () => {
    const q = fakeQuery();
    applyTaskListOrder(q, 'due_date', 'sideways');
    expect(q.calls[0]).toEqual([
      'due_date',
      { ascending: true, nullsFirst: false },
    ]);
  });

  it('sorts the key by its number, not as text', () => {
    expect(resolveTaskSortColumn('key')).toBe('key_number');
  });

  it('maps custom field columns to their JSON value', () => {
    expect(resolveTaskSortColumn('cf_story_points')).toBe(
      'custom_field_values->>story_points',
    );
  });

  it('ignores unknown columns and unsafe custom field keys', () => {
    for (const bad of [
      'assignee',
      'password',
      'cf_',
      'cf_x,id.desc',
      'cf_a->>b',
      '',
      null,
    ]) {
      expect(resolveTaskSortColumn(bad)).toBeNull();
    }

    const q = fakeQuery();
    applyTaskListOrder(q, 'cf_x,id.desc', 'asc');
    expect(q.calls[0]).toEqual(['sort_order', { ascending: true }]);
  });
});
