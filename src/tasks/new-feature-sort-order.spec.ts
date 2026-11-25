import { applyTaskListOrder } from './task-list-sort.util';

interface OrderCall {
  column: string;
  options: { ascending: boolean; nullsFirst?: boolean };
}

class FakeQuery {
  readonly calls: OrderCall[] = [];

  order(column: string, options: OrderCall['options']): FakeQuery {
    this.calls.push({ column, options });

    return this;
  }
}

describe('task list order', () => {
  it('keeps the manual order when no sort is asked for', () => {
    const query = applyTaskListOrder(new FakeQuery());

    expect(query.calls).toEqual([
      { column: 'sort_order', options: { ascending: true } },
      { column: 'created_at', options: { ascending: false } },
    ]);
  });

  it('sorts ascending with empty values last, then by id', () => {
    const query = applyTaskListOrder(new FakeQuery(), 'due_date', 'asc');

    expect(query.calls).toEqual([
      { column: 'due_date', options: { ascending: true, nullsFirst: false } },
      { column: 'id', options: { ascending: true } },
    ]);
  });

  it('sorts descending when asked', () => {
    const query = applyTaskListOrder(new FakeQuery(), 'key', 'desc');

    expect(query.calls[0]).toEqual({
      column: 'key_number',
      options: { ascending: false, nullsFirst: false },
    });
  });

  it('falls back to the manual order for an unknown column', () => {
    const query = applyTaskListOrder(new FakeQuery(), 'secret', 'desc');

    expect(query.calls[0].column).toBe('sort_order');
  });
});
