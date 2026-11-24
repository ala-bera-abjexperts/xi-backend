export interface IColumnConfigItem {
  id: string;
  visible: boolean;
  order: number;
}

export const DEFAULT_COLUMNS: Record<string, IColumnConfigItem[]> = {
  tasks: [
    { id: 'key', visible: true, order: 0 },
    { id: 'summary', visible: true, order: 1 },
    { id: 'status', visible: true, order: 2 },
    { id: 'priority', visible: true, order: 3 },
    { id: 'assignee', visible: true, order: 4 },
    { id: 'due_date', visible: true, order: 5 },
    { id: 'task_type', visible: false, order: 6 },
    { id: 'process', visible: false, order: 7 },
    { id: 'created_at', visible: false, order: 8 },
    { id: 'updated_at', visible: false, order: 9 },
  ],
  process_tasks: [
    { id: 'key', visible: true, order: 0 },
    { id: 'summary', visible: true, order: 1 },
    { id: 'status', visible: true, order: 2 },
    { id: 'priority', visible: true, order: 3 },
    { id: 'assignee', visible: true, order: 4 },
    { id: 'due_date', visible: true, order: 5 },
    { id: 'task_type', visible: false, order: 6 },
    { id: 'created_at', visible: false, order: 7 },
  ],
  processes: [
    { id: 'name', visible: true, order: 0 },
    { id: 'key', visible: true, order: 1 },
    { id: 'description', visible: true, order: 2 },
    { id: 'owner', visible: true, order: 3 },
    { id: 'status', visible: true, order: 4 },
    { id: 'level', visible: false, order: 5 },
    { id: 'created_at', visible: false, order: 6 },
  ],
  gdpr: [
    { id: 'key', visible: true, order: 0 },
    { id: 'activity', visible: true, order: 1 },
    { id: 'purpose', visible: true, order: 2 },
    { id: 'legal_basis', visible: true, order: 3 },
    { id: 'status', visible: true, order: 4 },
    { id: 'due_date', visible: true, order: 5 },
  ],
  'list-items': [
    { id: 'title', visible: true, order: 0 },
    { id: 'created_at', visible: true, order: 1 },
    { id: 'updated_at', visible: true, order: 2 },
  ],
  backlog: [
    { id: 'task_type', visible: true, order: 0 },
    { id: 'status', visible: false, order: 1 },
    { id: 'labels', visible: true, order: 2 },
    { id: 'due_date', visible: true, order: 3 },
    { id: 'priority', visible: true, order: 4 },
    { id: 'assignee', visible: true, order: 5 },
  ],
  plan_gantt: [
    { id: 'text', visible: true, order: 0 },
    { id: 'start', visible: true, order: 1 },
    { id: 'duration', visible: true, order: 2 },
    { id: 'progress', visible: true, order: 3 },
    { id: 'end', visible: false, order: 4 },
    { id: 'status', visible: false, order: 5 },
    { id: 'priority', visible: false, order: 6 },
    { id: 'assignee', visible: false, order: 7 },
    { id: 'due_date', visible: false, order: 8 },
    { id: 'task_type', visible: false, order: 9 },
    { id: 'process', visible: false, order: 10 },
  ],
  portfolio_gantt: [
    { id: 'text', visible: true, order: 0 },
    { id: 'rag', visible: true, order: 1 },
    { id: 'progress', visible: true, order: 2 },
    { id: 'owner', visible: true, order: 3 },
    { id: 'start', visible: true, order: 4 },
    { id: 'end', visible: true, order: 5 },
    { id: 'plan_status', visible: false, order: 6 },
    { id: 'budget', visible: false, order: 7 },
    { id: 'cpi', visible: false, order: 8 },
    { id: 'spi', visible: false, order: 9 },
    { id: 'last_letter_status', visible: false, order: 10 },
    { id: 'last_letter_date', visible: false, order: 11 },
    { id: 'duration', visible: false, order: 12 },
    { id: 'space_name', visible: false, order: 13 },
  ],
};

export function getDefaultColumns(viewId: string): IColumnConfigItem[] {
  return DEFAULT_COLUMNS[viewId] ?? [];
}
