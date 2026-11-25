import { resolveTaskSortColumn } from './task-list-sort.util';

describe('task list sort columns', () => {
  it.each([
    ['key', 'key_number'],
    ['summary', 'summary'],
    ['status', 'status'],
    ['priority', 'priority'],
    ['due_date', 'due_date'],
    ['created_at', 'created_at'],
    ['updated_at', 'updated_at'],
  ])('sorts the %s column by %s', (sortBy, column) => {
    expect(resolveTaskSortColumn(sortBy)).toBe(column);
  });

  it('sorts a custom field by its JSON value', () => {
    expect(resolveTaskSortColumn('cf_story_points')).toBe(
      'custom_field_values->>story_points',
    );
  });

  it.each([undefined, null, '', 'password', 'cf_bad-key', 'cf_a;drop'])(
    'ignores %p',
    (sortBy) => {
      expect(resolveTaskSortColumn(sortBy)).toBeNull();
    },
  );
});
