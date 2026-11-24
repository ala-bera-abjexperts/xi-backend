export const TASK_SIDEBAR_PREFERENCE_VERSION = 1;

export const TASK_SIDEBAR_PROPERTY_IDS = [
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
  // Keep new ids last: normalizeTaskSidebarProperties appends ids missing from a
  // stored config, so a new id must sort to the end for existing users' ordering.
  'sla',
  // Git integration ticket 5: pull requests and branches of the task.
  'development',
] as const;

export type TaskSidebarPropertyId = (typeof TASK_SIDEBAR_PROPERTY_IDS)[number];

export interface TaskSidebarPropertyConfig {
  id: TaskSidebarPropertyId;
  visible: boolean;
  order: number;
}

export interface TaskSidebarConfig {
  version: typeof TASK_SIDEBAR_PREFERENCE_VERSION;
  properties: TaskSidebarPropertyConfig[];
}

export const DEFAULT_TASK_SIDEBAR_PROPERTIES: TaskSidebarPropertyConfig[] =
  TASK_SIDEBAR_PROPERTY_IDS.map((id, order) => ({ id, visible: true, order }));

export const TASK_SIDEBAR_SETTINGS_KEY = 'taskDetailSidebar';
export const TASK_SIDEBAR_VIEW_PREFIX = 'task_detail_sidebar:';

export function getTaskSidebarViewId(spaceId: string): string {
  return `${TASK_SIDEBAR_VIEW_PREFIX}${spaceId}`;
}

export function normalizeTaskSidebarProperties(
  input: unknown,
): TaskSidebarPropertyConfig[] {
  if (!Array.isArray(input)) return DEFAULT_TASK_SIDEBAR_PROPERTIES;

  const allowed = new Set<string>(TASK_SIDEBAR_PROPERTY_IDS);
  const seen = new Set<string>();

  const known = input
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === 'object' && item !== null,
    )
    .filter((item) => typeof item.id === 'string' && allowed.has(item.id))
    .filter((item) => {
      if (seen.has(item.id as string)) return false;

      seen.add(item.id as string);

      return true;
    })
    .map((item) => {
      const fallback = DEFAULT_TASK_SIDEBAR_PROPERTIES.find(
        (def) => def.id === item.id,
      )!;

      return {
        id: item.id as TaskSidebarPropertyId,
        visible:
          typeof item.visible === 'boolean' ? item.visible : fallback.visible,
        order: typeof item.order === 'number' ? item.order : fallback.order,
      };
    })
    .sort((a, b) => a.order - b.order);

  const missing = DEFAULT_TASK_SIDEBAR_PROPERTIES.filter(
    (item) => !seen.has(item.id),
  );

  return [...known, ...missing].map((item, order) => ({ ...item, order }));
}

export function toTaskSidebarConfig(input: unknown): TaskSidebarConfig {
  return {
    version: TASK_SIDEBAR_PREFERENCE_VERSION,
    properties: normalizeTaskSidebarProperties(input),
  };
}
