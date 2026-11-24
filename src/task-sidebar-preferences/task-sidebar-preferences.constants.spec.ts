import {
  DEFAULT_TASK_SIDEBAR_PROPERTIES,
  TASK_SIDEBAR_PROPERTY_IDS,
  normalizeTaskSidebarProperties,
} from './task-sidebar-preferences.constants';

const byId = (properties: { id: string; visible: boolean; order: number }[], id: string) =>
  properties.find((property) => property.id === id);

describe('task sidebar property contract', () => {
  // SaveTaskSidebarPreferencesDto validates ids with @IsIn(TASK_SIDEBAR_PROPERTY_IDS),
  // so an id the backend does not know makes the WHOLE save 400 — a frontend that
  // ships a new id before this list does breaks every sidebar save, not just the new
  // row. The frontend mirrors this list in
  // risk-management-app/src/models/task-sidebar-preferences.model.ts and pins it the
  // same way, so a drift in either repo fails that repo's own suite.
  it('matches the frontend contract exactly, with new ids appended last', () => {
    expect([...TASK_SIDEBAR_PROPERTY_IDS]).toEqual([
      'process',
      'task_type',
      'status',
      'priority',
      'resolution',
      'parent_task',
      'assignee',
      'reporter',
      'start_date',
      'due_date',
      'duration',
      'progress',
      'labels',
      'time_tracking',
      'estimated_cost',
      'resource_planning',
      'created_at',
      'updated_at',
      'sla',
      'development',
    ]);
  });

  it('stays within the DTO array cap', () => {
    expect(TASK_SIDEBAR_PROPERTY_IDS.length).toBeLessThanOrEqual(32);
  });
});

describe('normalizeTaskSidebarProperties', () => {
  it('appends an id the stored config predates, visible, at the end', () => {
    const stored = DEFAULT_TASK_SIDEBAR_PROPERTIES.filter(
      (property) => property.id !== 'development',
    ).map((property) => ({ ...property, visible: false }));

    const result = normalizeTaskSidebarProperties(stored);

    expect(result).toHaveLength(TASK_SIDEBAR_PROPERTY_IDS.length);
    expect(byId(result, 'development')).toEqual({
      id: 'development',
      visible: true,
      order: result.length - 1,
    });
    expect(byId(result, 'assignee')?.visible).toBe(false);
  });

  it('drops only the unrecognised entry, never the whole config', () => {
    const result = normalizeTaskSidebarProperties([
      { id: 'assignee', visible: false, order: 0 },
      { id: 'a_property_from_a_newer_release', visible: true, order: 1 },
      { id: 'status', visible: false, order: 2 },
    ]);

    expect(byId(result, 'assignee')?.visible).toBe(false);
    expect(byId(result, 'status')?.visible).toBe(false);
    expect(byId(result, 'a_property_from_a_newer_release')).toBeUndefined();
    expect(result).toHaveLength(TASK_SIDEBAR_PROPERTY_IDS.length);
  });

  it('preserves stored order, renumbers contiguously and de-duplicates', () => {
    const result = normalizeTaskSidebarProperties([
      { id: 'status', visible: true, order: 5 },
      { id: 'assignee', visible: true, order: 1 },
      { id: 'assignee', visible: false, order: 2 },
    ]);

    expect(result[0].id).toBe('assignee');
    expect(result[1].id).toBe('status');
    expect(byId(result, 'assignee')?.visible).toBe(true);
    expect(result.map((property) => property.order)).toEqual(
      result.map((_, index) => index),
    );
  });

  it('falls back to defaults only when the input is not an array', () => {
    expect(normalizeTaskSidebarProperties(undefined)).toEqual(
      DEFAULT_TASK_SIDEBAR_PROPERTIES,
    );
    expect(normalizeTaskSidebarProperties('nonsense')).toEqual(
      DEFAULT_TASK_SIDEBAR_PROPERTIES,
    );
  });
});
