import type { CatalogTrigger } from '../../automation-trigger-catalog.service';

const TASK_OUTPUT = {
  type: 'object',
  properties: {
    task: {
      type: 'object',
      properties: {
        // `key` and `summary` lead deliberately: they are what a person recognises ("XE-T350",
        // "Fix the login bug"), and the variable picker renders these in declaration order. Before
        // this, `id` was the only identifier on offer, so every message template ended up embedding a
        // raw UUID. Every task event producer is guaranteed to populate both.
        key: { type: 'string', title: 'Task Key' },
        summary: { type: 'string', title: 'Summary' },
        id: { type: 'string', title: 'Task ID (UUID)' },
        description: { type: 'string', title: 'Description' },
        status: { type: 'string', title: 'Status' },
        priority: { type: 'string', title: 'Priority' },
        space_id: { type: 'string', title: 'Space ID' },
        organization_id: { type: 'string', title: 'Organization ID' },
        assigned_to: { type: 'string', title: 'Assigned To (User ID)' },
        created_at: { type: 'string', title: 'Created At' },
      },
    },
  },
};

const TASK_FILTER_PROPS = {
  priority: {
    type: 'string',
    title: 'Priority filter',
    enum: ['lowest', 'low', 'medium', 'high', 'highest', 'critical'],
    description: 'Leave blank to fire for any priority',
  },
  status: {
    type: 'string',
    title: 'Status filter',
    enum: ['open', 'in_progress', 'review', 'done', 'closed', 'blocked'],
    description: 'Leave blank to fire for any status',
  },
  taskType: {
    type: 'string',
    title: 'Task type filter',
    enum: ['task', 'subtask', 'story', 'epic', 'bug'],
    description: 'Leave blank to fire for any task type',
  },
};

export const taskCreatedTrigger: CatalogTrigger = {
  kind: 'app.task.created',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Task created', de: 'Aufgabe erstellt' },
  description: {
    en: 'Fires when a new task is created in this space',
    de: 'Wird ausgelöst, wenn eine neue Aufgabe in diesem Bereich erstellt wird',
  },
  icon: 'bx-plus-circle',
  configSchema: {
    type: 'object',
    properties: { ...TASK_FILTER_PROPS },
  },
  outputSchema: TASK_OUTPUT,
};

export const taskUpdatedTrigger: CatalogTrigger = {
  kind: 'app.task.updated',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Task updated', de: 'Aufgabe aktualisiert' },
  description: {
    en: 'Fires when any task field changes in this space',
    de: 'Wird ausgelöst, wenn sich ein Aufgabenfeld in diesem Bereich ändert',
  },
  icon: 'bx-edit',
  configSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        title: 'Task to watch',
        description:
          'Specific task ID — leave blank to fire for any task in this space',
      },
      assignedToUserId: {
        type: 'string',
        title: 'Assigned to user',
        description:
          'Only fire when assigned to this user — leave blank for any',
      },
      ...TASK_FILTER_PROPS,
    },
  },
  outputSchema: {
    ...TASK_OUTPUT,
    properties: {
      ...TASK_OUTPUT.properties,
      changedFields: {
        type: 'array',
        title: 'Changed fields',
        items: { type: 'string' },
      },
    },
  },
};

export const taskStatusChangedTrigger: CatalogTrigger = {
  kind: 'app.task.status_changed',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Task status changed', de: 'Aufgabenstatus geändert' },
  description: {
    en: 'Fires when a task status changes',
    de: 'Wird ausgelöst, wenn sich der Status einer Aufgabe ändert',
  },
  icon: 'bx-transfer',
  configSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        title: 'Task to watch',
        description: 'Specific task ID — leave blank to fire for any task',
      },
      fromStatus: {
        type: 'string',
        title: 'From status',
        enum: ['open', 'in_progress', 'review', 'done', 'closed', 'blocked'],
        description:
          'Only fire when transitioning FROM this status — leave blank for any',
      },
      toStatus: {
        type: 'string',
        title: 'To status',
        enum: ['open', 'in_progress', 'review', 'done', 'closed', 'blocked'],
        description:
          'Only fire when transitioning TO this status — leave blank for any',
      },

      // Preferred over the two enums above. Those match `tasks.status`, a six-value legacy text
      // column derived from the status category; it has drifted in real data and cannot separate
      // the many statuses sharing one category. These match `old_status_id`/`new_status_id`,
      // which the emitter already writes, so they identify a status exactly.
      previousStatusId: {
        type: 'string',
        title: 'From status (exact)',
        description:
          'Only fire when transitioning FROM this specific status — leave blank for any',
      },
      newStatusId: {
        type: 'string',
        title: 'To status (exact)',
        description:
          'Only fire when transitioning TO this specific status — leave blank for any',
      },
    },
  },
  outputSchema: {
    ...TASK_OUTPUT,
    properties: {
      ...TASK_OUTPUT.properties,
      previousStatus: { type: 'string', title: 'Previous status' },
      newStatus: { type: 'string', title: 'New status' },
      old_status_id: { type: 'string', title: 'Previous status ID' },
      new_status_id: { type: 'string', title: 'New status ID' },
    },
  },
};

/**
 * Workflow-scoped sibling of `taskStatusChangedTrigger`.
 *
 * Fires only when the workflow engine drives the transition — not on a direct status edit, a bulk
 * update, or a board drag. Both triggers fire on a workflow transition; that is intended, and the
 * description tells an admin which question each one answers.
 */
export const workflowStatusReachedTrigger: CatalogTrigger = {
  kind: 'app.workflow.status_reached',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'Workflow reached status',
    de: 'Workflow hat Status erreicht',
  },
  description: {
    en: 'Fires when a workflow transition moves a task into a status. Unlike "Task status changed", it ignores direct edits, bulk updates and board drags.',
    de: 'Wird ausgelöst, wenn ein Workflow-Übergang eine Aufgabe in einen Status bewegt. Anders als "Aufgabenstatus geändert" ignoriert er Direktbearbeitungen, Massenaktualisierungen und Board-Verschiebungen.',
  },
  icon: 'bx-git-merge',
  configSchema: {
    type: 'object',
    properties: {
      newStatusId: {
        type: 'string',
        title: 'Status reached',
        description:
          'Only fire when the workflow reaches this status — leave blank for any',
      },
      workflowId: {
        type: 'string',
        title: 'Workflow',
        description: 'Only fire for this workflow — leave blank for any',
      },
    },
  },
  outputSchema: {
    ...TASK_OUTPUT,
    properties: {
      ...TASK_OUTPUT.properties,
      workflow_id: { type: 'string', title: 'Workflow ID' },
      workflow_name: { type: 'string', title: 'Workflow name' },
      transition_id: { type: 'string', title: 'Transition ID' },
      transition_name: { type: 'string', title: 'Transition name' },
      to_node_id: { type: 'string', title: 'Target node ID' },
      previous_status: { type: 'string', title: 'Previous status' },
      new_status: { type: 'string', title: 'New status' },
      old_status_id: { type: 'string', title: 'Previous status ID' },
      new_status_id: { type: 'string', title: 'New status ID' },
    },
  },
};

export const taskAssignedTrigger: CatalogTrigger = {
  kind: 'app.task.assigned',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Task assigned', de: 'Aufgabe zugewiesen' },
  description: {
    en: 'Fires when a task is assigned to a user',
    de: 'Wird ausgelöst, wenn eine Aufgabe einem Benutzer zugewiesen wird',
  },
  icon: 'bx-user-check',
  configSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        title: 'Task to watch',
        description: 'Specific task ID — leave blank for any task',
      },
      assignedToUserId: {
        type: 'string',
        title: 'Assigned to user',
        description:
          'Only fire when assigned to this user — leave blank for any',
      },
    },
  },
  outputSchema: {
    ...TASK_OUTPUT,
    properties: {
      ...TASK_OUTPUT.properties,
      assignedUserId: { type: 'string', title: 'Assigned User ID' },
    },
  },
};

export const taskCommentAddedTrigger: CatalogTrigger = {
  kind: 'app.task.comment_added',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Task comment added', de: 'Aufgabenkommentar hinzugefügt' },
  description: {
    en: 'Fires when a comment is added to a task',
    de: 'Wird ausgelöst, wenn ein Kommentar zu einer Aufgabe hinzugefügt wird',
  },
  icon: 'bx-comment',
  configSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        title: 'Task to watch',
        description: 'Specific task ID — leave blank for any task',
      },
      authorUserId: {
        type: 'string',
        title: 'Author user ID',
        description:
          'Only fire when comment is by this user — leave blank for any',
      },
      ...TASK_FILTER_PROPS,
    },
  },
  outputSchema: {
    ...TASK_OUTPUT,
    properties: {
      ...TASK_OUTPUT.properties,
      comment: {
        type: 'object',
        title: 'Comment',
        properties: {
          id: { type: 'string', title: 'Comment ID' },
          body: { type: 'string', title: 'Comment body' },
          author_id: { type: 'string', title: 'Author User ID' },
        },
      },
    },
  },
};

export const planCreatedTrigger: CatalogTrigger = {
  kind: 'app.plan.created',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Plan created', de: 'Plan erstellt' },
  description: {
    en: 'Fires when a new plan is created',
    de: 'Wird ausgelöst, wenn ein neuer Plan erstellt wird',
  },
  icon: 'bx-calendar-plus',
  configSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        title: 'Specific plan',
        description: 'Leave blank to fire for any plan in this space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Plan ID' },
          name: { type: 'string', title: 'Plan name' },
          space_id: { type: 'string', title: 'Space ID' },
          status: { type: 'string', title: 'Status' },
        },
      },
    },
  },
};

export const planPublishedTrigger: CatalogTrigger = {
  kind: 'app.plan.published',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Plan published', de: 'Plan veröffentlicht' },
  description: {
    en: 'Fires when a plan is published',
    de: 'Wird ausgelöst, wenn ein Plan veröffentlicht wird',
  },
  icon: 'bx-calendar-check',
  configSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        title: 'Specific plan',
        description: 'Leave blank to fire for any plan in this space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Plan ID' },
          name: { type: 'string', title: 'Plan name' },
          space_id: { type: 'string', title: 'Space ID' },
          status: { type: 'string', title: 'Status' },
        },
      },
    },
  },
};

export const wikiPageCreatedTrigger: CatalogTrigger = {
  kind: 'app.wiki.page_created',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Wiki page created', de: 'Wiki-Seite erstellt' },
  description: {
    en: 'Fires when a new wiki page is created',
    de: 'Wird ausgelöst, wenn eine neue Wiki-Seite erstellt wird',
  },
  icon: 'bx-book-add',
  configSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        title: 'Specific page',
        description: 'Leave blank to fire for any wiki page in this space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      page: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Page ID' },
          title: { type: 'string', title: 'Title' },
          space_id: { type: 'string', title: 'Space ID' },
          status: { type: 'string', title: 'Status' },
        },
      },
    },
  },
};

export const wikiPagePublishedTrigger: CatalogTrigger = {
  kind: 'app.wiki.page_published',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Wiki page published', de: 'Wiki-Seite veröffentlicht' },
  description: {
    en: 'Fires when a wiki page is published',
    de: 'Wird ausgelöst, wenn eine Wiki-Seite veröffentlicht wird',
  },
  icon: 'bx-book-open',
  configSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        title: 'Specific page',
        description: 'Leave blank to fire for any wiki page in this space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      page: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Page ID' },
          title: { type: 'string', title: 'Title' },
          space_id: { type: 'string', title: 'Space ID' },
          status: { type: 'string', title: 'Status' },
        },
      },
    },
  },
};

export const processCreatedTrigger: CatalogTrigger = {
  kind: 'app.process.created',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Process created', de: 'Prozess erstellt' },
  description: {
    en: 'Fires when a new business process is added',
    de: 'Wird ausgelöst, wenn ein neuer Geschäftsprozess hinzugefügt wird',
  },
  icon: 'bx-git-branch',
  configSchema: {
    type: 'object',
    properties: {
      processId: {
        type: 'string',
        title: 'Specific process',
        description: 'Leave blank to fire for any process in this space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      process: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Process ID' },
          name: { type: 'string', title: 'Name' },
          space_id: { type: 'string', title: 'Space ID' },
          organization_id: { type: 'string', title: 'Organization ID' },
        },
      },
    },
  },
};

export const processUpdatedTrigger: CatalogTrigger = {
  kind: 'app.process.updated',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Process updated', de: 'Prozess aktualisiert' },
  description: {
    en: 'Fires when a business process is updated',
    de: 'Wird ausgelöst, wenn ein Geschäftsprozess aktualisiert wird',
  },
  icon: 'bx-git-commit',
  configSchema: {
    type: 'object',
    properties: {
      processId: {
        type: 'string',
        title: 'Specific process',
        description: 'Leave blank to fire for any process in this space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      process: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Process ID' },
          name: { type: 'string', title: 'Name' },
          space_id: { type: 'string', title: 'Space ID' },
          organization_id: { type: 'string', title: 'Organization ID' },
        },
      },
    },
  },
};

export const taskDeletedTrigger: CatalogTrigger = {
  kind: 'app.task.deleted',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Task deleted', de: 'Aufgabe gelöscht' },
  description: {
    en: 'Fires when a task is deleted or archived',
    de: 'Wird ausgelöst, wenn eine Aufgabe gelöscht oder archiviert wird',
  },
  icon: 'bx-trash',
  configSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        title: 'Task to watch',
        description:
          'Specific task ID — leave blank to fire for any task in this space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      // Same nested `task` shape as every other task event, so a delete message can name the task
      // rather than only its UUID. `taskId` stays for automations built before this.
      task: {
        type: 'object',
        properties: {
          key: { type: 'string', title: 'Task Key' },
          summary: { type: 'string', title: 'Summary' },
          id: { type: 'string', title: 'Task ID (UUID)' },
          space_id: { type: 'string', title: 'Space ID' },
        },
      },
      taskId: { type: 'string', title: 'Task ID (UUID)' },
      space_id: { type: 'string', title: 'Space ID' },
    },
  },
};

export const riskThresholdCrossedTrigger: CatalogTrigger = {
  kind: 'app.risk.threshold_crossed',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Risk threshold crossed', de: 'Risikoschwelle überschritten' },
  description: {
    en: 'Fires when a process risk score is recalculated — use threshold + direction config to filter',
    de: 'Wird ausgelöst, wenn ein Prozessrisiko neu berechnet wird',
  },
  icon: 'bx-error-alt',
  configSchema: {
    type: 'object',
    properties: {
      threshold: {
        type: 'number',
        title: 'Risk score threshold',
        minimum: 0,
        maximum: 100,
        description: 'Leave blank to fire on any recalculation',
      },
      direction: {
        type: 'string',
        title: 'Direction',
        enum: ['above', 'below', 'any'],
        default: 'above',
        description:
          'above = fires when score exceeds threshold · below = fires when it drops below',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      process: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Process ID' },
          name: { type: 'string', title: 'Name' },
          space_id: { type: 'string', title: 'Space ID' },
          organization_id: { type: 'string', title: 'Organization ID' },
        },
      },
      riskScore: { type: 'number', title: 'New risk score' },
    },
  },
};

export const riskRecalculatedTrigger: CatalogTrigger = {
  kind: 'app.risk.recalculated',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Risk recalculated', de: 'Risiko neu berechnet' },
  description: {
    en: 'Fires whenever a process risk score is recalculated',
    de: 'Wird ausgelöst, wenn ein Prozessrisiko neu berechnet wird',
  },
  icon: 'bx-calculator',
  configSchema: {
    type: 'object',
    properties: {
      thresholdAbove: {
        type: 'number',
        title: 'Threshold (above)',
        minimum: 0,
        maximum: 100,
        description:
          'Fire only when recalculated score reaches or exceeds this value — leave blank for any',
      },
      thresholdBelow: {
        type: 'number',
        title: 'Threshold (below)',
        minimum: 0,
        maximum: 100,
        description:
          'Fire only when recalculated score drops to or below this value — leave blank for any',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      process: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Process ID' },
          name: { type: 'string', title: 'Name' },
          space_id: { type: 'string', title: 'Space ID' },
          organization_id: { type: 'string', title: 'Organization ID' },
        },
      },
      riskScore: { type: 'number', title: 'New risk score' },
    },
  },
};

export const planBaselineActivatedTrigger: CatalogTrigger = {
  kind: 'app.plan.baseline_activated',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Plan baseline activated', de: 'Plan-Basislinie aktiviert' },
  description: {
    en: 'Fires when a new baseline is created or an existing baseline is activated for a plan',
    de: 'Wird ausgelöst, wenn eine Basislinie für einen Plan erstellt oder aktiviert wird',
  },
  icon: 'bx-calendar-star',
  configSchema: {
    type: 'object',
    properties: {
      planId: {
        type: 'string',
        title: 'Specific plan',
        description: 'Leave blank to fire for any plan in this space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Plan ID' },
          name: { type: 'string', title: 'Name' },
          space_id: { type: 'string', title: 'Space ID' },
          status: { type: 'string', title: 'Status' },
        },
      },
      baselineId: { type: 'string', title: 'Baseline ID' },
    },
  },
};

export const wikiPageUpdatedTrigger: CatalogTrigger = {
  kind: 'app.wiki.page_updated',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Wiki page updated', de: 'Wiki-Seite aktualisiert' },
  description: {
    en: 'Fires when a wiki page content or metadata is updated',
    de: 'Wird ausgelöst, wenn eine Wiki-Seite aktualisiert wird',
  },
  icon: 'bx-edit-alt',
  configSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        title: 'Specific page',
        description: 'Leave blank to fire for any wiki page in this space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      page: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Page ID' },
          title: { type: 'string', title: 'Title' },
          space_id: { type: 'string', title: 'Space ID' },
          status: { type: 'string', title: 'Status' },
        },
      },
      changedFields: {
        type: 'array',
        title: 'Changed fields',
        items: { type: 'string' },
      },
    },
  },
};

export const processRelationshipChangedTrigger: CatalogTrigger = {
  kind: 'app.process.relationship_changed',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'Process relationship changed',
    de: 'Prozessbeziehung geändert',
  },
  description: {
    en: 'Fires when a parent-child relationship between processes is created, deleted, or replaced via the edit form',
    de: 'Wird ausgelöst, wenn eine Eltern-Kind-Beziehung zwischen Prozessen erstellt, gelöscht oder über das Bearbeitungsformular ersetzt wird',
  },
  icon: 'bx-git-branch',
  configSchema: {
    type: 'object',
    properties: {
      childProcessId: {
        type: 'string',
        title: 'Child Process ID',
        description:
          'Only fire when this specific child process changes parents — leave blank for any',
      },
      action: {
        type: 'string',
        title: 'Action',
        enum: ['created', 'deleted', 'replaced', 'any'],
        description:
          'Filter by relationship action; leave blank for any. "replaced" fires when parents are changed via the edit form.',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      child_process_id: { type: 'string', title: 'Child Process ID' },
      parent_process_id: {
        type: 'string',
        title: 'Parent Process ID (first parent for replaced)',
      },
      parent_process_ids: {
        type: 'array',
        items: { type: 'string' },
        title: 'New parent process IDs (replaced action)',
      },
      action: {
        type: 'string',
        title: 'Action (created | deleted | replaced)',
      },
      organization_id: { type: 'string', title: 'Organization ID' },
      space_id: { type: 'string', title: 'Space ID' },
    },
  },
};

const ASSET_OUTPUT = {
  type: 'object',
  properties: {
    asset: {
      type: 'object',
      properties: {
        id: { type: 'string', title: 'Asset ID' },
        name: { type: 'string', title: 'Name' },
        title: { type: 'string', title: 'Title (legacy list assets)' },
        schema_id: { type: 'string', title: 'Schema ID' },
        object_type_id: { type: 'string', title: 'Object Type ID' },
        space_id: { type: 'string', title: 'Space ID' },
        organization_id: { type: 'string', title: 'Organization ID' },
      },
    },
    asset_id: { type: 'string', title: 'Asset ID' },
    space_id: { type: 'string', title: 'Space ID' },
    organization_id: { type: 'string', title: 'Organization ID' },
  },
};

export const assetCreatedTrigger: CatalogTrigger = {
  kind: 'app.asset.created',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Asset created', de: 'Asset erstellt' },
  description: {
    en: 'Fires when a new asset item is created',
    de: 'Wird ausgelöst, wenn ein neues Asset erstellt wird',
  },
  icon: 'bx-box',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      asset: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Asset ID' },
          title: { type: 'string', title: 'Title' },
          schema_id: { type: 'string', title: 'Schema ID' },
          space_id: { type: 'string', title: 'Space ID' },
          organization_id: { type: 'string', title: 'Organization ID' },
        },
      },
    },
  },
};

export const assetUpdatedTrigger: CatalogTrigger = {
  kind: 'app.asset.updated',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Asset updated', de: 'Asset aktualisiert' },
  description: {
    en: 'Fires when an asset item is updated',
    de: 'Wird ausgelöst, wenn ein Asset aktualisiert wird',
  },
  icon: 'bx-edit',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      asset: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Asset ID' },
          title: { type: 'string', title: 'Title' },
          schema_id: { type: 'string', title: 'Schema ID' },
          space_id: { type: 'string', title: 'Space ID' },
          organization_id: { type: 'string', title: 'Organization ID' },
        },
      },
      changedFields: {
        type: 'array',
        title: 'Changed fields',
        items: { type: 'string' },
      },
    },
  },
};

export const gdprRecordAddedTrigger: CatalogTrigger = {
  kind: 'app.gdpr.record_added',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'GDPR record added', de: 'DSGVO-Eintrag hinzugefügt' },
  description: {
    en: 'Fires when a new GDPR record is added to the spreadsheet',
    de: 'Wird ausgelöst, wenn ein neuer DSGVO-Eintrag hinzugefügt wird',
  },
  icon: 'bx-shield',
  configSchema: {
    type: 'object',
    properties: {},
  },
  outputSchema: {
    type: 'object',
    properties: {
      record: {
        type: 'object',
        properties: {
          id: { type: 'string', title: 'Record ID' },
          organization_id: { type: 'string', title: 'Organization ID' },
          spreadsheet_id: { type: 'string', title: 'Spreadsheet ID' },
        },
      },
    },
  },
};

export const userInvitedTrigger: CatalogTrigger = {
  kind: 'app.user.invited',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'User invited', de: 'Benutzer eingeladen' },
  description: {
    en: 'Fires when a user is invited to the organization',
    de: 'Wird ausgelöst, wenn ein Benutzer zur Organisation eingeladen wird',
  },
  icon: 'bx-user-plus',
  configSchema: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        title: 'Role filter',
        description: 'Leave blank to fire for any role',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      user: {
        type: 'object',
        title: 'User',
        properties: {
          id: { type: 'string', title: 'User ID' },
          email: { type: 'string', title: 'Email' },
          name: { type: 'string', title: 'Name' },
        },
      },
      email: { type: 'string', title: 'Email' },
      role: { type: 'string', title: 'Role' },
      organization_id: { type: 'string', title: 'Organization ID' },
      invitation_id: { type: 'string', title: 'Invitation ID' },
    },
  },
};

export const spaceMemberAddedTrigger: CatalogTrigger = {
  kind: 'app.space.member_added',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Space member added', de: 'Space-Mitglied hinzugefügt' },
  description: {
    en: 'Fires when a user, group, or role is added to a space',
    de: 'Wird ausgelöst, wenn ein Benutzer, eine Gruppe oder Rolle einem Space hinzugefügt wird',
  },
  icon: 'bx-group',
  configSchema: {
    type: 'object',
    properties: {
      spaceId: {
        type: 'string',
        title: 'Space filter',
        description: 'Leave blank to fire for any space',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      user: {
        type: 'object',
        title: 'User',
        properties: {
          id: { type: 'string', title: 'User ID' },
          email: { type: 'string', title: 'Email' },
          name: { type: 'string', title: 'Name' },
        },
      },
      space_id: { type: 'string', title: 'Space ID' },
      user_id: { type: 'string', title: 'User ID' },
      space_role: { type: 'string', title: 'Space Role' },
      member_type: { type: 'string', title: 'Member Type' },
    },
  },
};

export const wikiRelationAddedTrigger: CatalogTrigger = {
  kind: 'app.wiki.relation_added',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Wiki relation added', de: 'Wiki-Verknüpfung hinzugefügt' },
  description: {
    en: 'Fires when a relation is added to a wiki page',
    de: 'Wird ausgelöst, wenn einer Wiki-Seite eine Verknüpfung hinzugefügt wird',
  },
  icon: 'bx-link',
  configSchema: {
    type: 'object',
    properties: {
      pageId: {
        type: 'string',
        title: 'Page ID',
        description: 'Only fire for this specific page — leave blank for any',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      page: {
        type: 'object',
        title: 'Wiki page',
        properties: {
          id: { type: 'string', title: 'ID' },
          title: { type: 'string', title: 'Title' },
          space_id: { type: 'string', title: 'Space ID' },
        },
      },
      relatedPageId: { type: 'string', title: 'Related page ID' },
      relationType: { type: 'string', title: 'Relation type' },
    },
  },
};

export const assetRelationAddedTrigger: CatalogTrigger = {
  kind: 'app.asset.relation_added',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'List item relation added',
    de: 'Listen-Element-Verknüpfung hinzugefügt',
  },
  description: {
    en: 'Fires when a relation is added between two list items',
    de: 'Wird ausgelöst, wenn eine Verknüpfung zwischen zwei Listen-Elementen hinzugefügt wird',
  },
  icon: 'bx-transfer-alt',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'List',
        description: 'Only fire for items of this list — leave blank for any',
      },
      sourceItemId: {
        type: 'string',
        title: 'List item ID',
        description: 'Only fire for this specific item — leave blank for any',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      assetItem: {
        type: 'object',
        title: 'Asset item',
        properties: {
          id: { type: 'string', title: 'ID' },
          title: { type: 'string', title: 'Title' },
          schema_id: { type: 'string', title: 'Schema ID' },
          organization_id: { type: 'string', title: 'Organization ID' },
        },
      },
      relatedAssetItemId: { type: 'string', title: 'Related asset item ID' },
      relationType: { type: 'string', title: 'Relation type' },
    },
  },
};

export const taskRelationAddedTrigger: CatalogTrigger = {
  kind: 'app.task.relation_added',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Task relation added', de: 'Aufgaben-Verknüpfung hinzugefügt' },
  description: {
    en: 'Fires when a relation is added to a task',
    de: 'Wird ausgelöst, wenn einer Aufgabe eine Verknüpfung hinzugefügt wird',
  },
  icon: 'bx-transfer-alt',
  configSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        title: 'Task ID',
        description: 'Only fire for this specific task — leave blank for any',
      },
    },
  },
  outputSchema: {
    ...TASK_OUTPUT,
    properties: {
      ...TASK_OUTPUT.properties,
      targetType: { type: 'string', title: 'Target type' },
      relatedTaskId: { type: 'string', title: 'Related task ID' },
      relatedWikiPageId: { type: 'string', title: 'Related wiki page ID' },
      relationType: { type: 'string', title: 'Relation type' },
    },
  },
};

export const taskAttachmentAddedTrigger: CatalogTrigger = {
  kind: 'app.task.attachment_added',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Attachment added', de: 'Anhang hinzugefügt' },
  description: {
    en: 'Fires when an attachment is added to a task',
    de: 'Wird ausgelöst, wenn einer Aufgabe ein Anhang hinzugefügt wird',
  },
  icon: 'bx-paperclip',
  configSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        title: 'Task ID',
        description: 'Only fire for this specific task — leave blank for any',
      },
    },
  },
  outputSchema: {
    ...TASK_OUTPUT,
    properties: {
      ...TASK_OUTPUT.properties,
      attachment: {
        type: 'object',
        title: 'Attachment',
        properties: {
          id: { type: 'string', title: 'ID' },
          name: { type: 'string', title: 'File name' },
          url: { type: 'string', title: 'File URL' },
          size: { type: 'number', title: 'Size (bytes)' },
          mime_type: { type: 'string', title: 'MIME type' },
        },
      },
    },
  },
};

export const taskTimeLoggedTrigger: CatalogTrigger = {
  kind: 'app.task.time_logged',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Time logged', de: 'Zeit erfasst' },
  description: {
    en: 'Fires when time is logged on a task',
    de: 'Wird ausgelöst, wenn Zeit für eine Aufgabe erfasst wird',
  },
  icon: 'bx-time-five',
  configSchema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        title: 'Task ID',
        description: 'Only fire for this specific task — leave blank for any',
      },
    },
  },
  outputSchema: {
    ...TASK_OUTPUT,
    properties: {
      ...TASK_OUTPUT.properties,
      timeEntry: {
        type: 'object',
        title: 'Time entry',
        properties: {
          id: { type: 'string', title: 'ID' },
          duration_minutes: { type: 'number', title: 'Duration (minutes)' },
          description: { type: 'string', title: 'Description' },
          logged_at: { type: 'string', title: 'Logged at' },
        },
      },
    },
  },
};

export const assetObjectCreatedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.created',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Asset Object created', de: 'Asset-Objekt erstellt' },
  description: {
    en: 'Fires when a new asset object is created in the asset management module',
    de: 'Wird ausgelöst, wenn ein neues Asset-Objekt erstellt wird',
  },
  icon: 'bx-cube-alt',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      created_by: { type: 'string', title: 'Created by (User ID)' },
    },
  },
};

export const assetObjectUpdatedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.updated',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Asset Object updated', de: 'Asset-Objekt aktualisiert' },
  description: {
    en: 'Fires when an asset object is updated in the asset management module',
    de: 'Wird ausgelöst, wenn ein Asset-Objekt aktualisiert wird',
  },
  icon: 'bx-cube',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      changedFields: {
        type: 'array',
        title: 'Changed fields',
        items: { type: 'string' },
      },
      updated_by: { type: 'string', title: 'Updated by (User ID)' },
    },
  },
};

export const assetObjectDeletedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.deleted',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Asset Object deleted', de: 'Asset-Objekt gelöscht' },
  description: {
    en: 'Fires when an asset object is deleted from the asset management module',
    de: 'Wird ausgelöst, wenn ein Asset-Objekt gelöscht wird',
  },
  icon: 'bx-trash',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      deleted_by: { type: 'string', title: 'Deleted by (User ID)' },
    },
  },
};

export const assetObjectTypeChangedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.type_changed',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Asset Object type changed', de: 'Asset-Objekttyp geändert' },
  description: {
    en: 'Fires when an asset object is reassigned to a different object type',
    de: 'Wird ausgelöst, wenn einem Asset-Objekt ein anderer Objekttyp zugewiesen wird',
  },
  icon: 'bx-transfer',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
      newObjectTypeId: {
        type: 'string',
        title: 'New object type ID',
        description:
          'Only fire when changed to this type — leave blank for any',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      old_type_id: { type: 'string', title: 'Previous object type ID' },
      new_type_id: { type: 'string', title: 'New object type ID' },
      updated_by: { type: 'string', title: 'Updated by (User ID)' },
    },
  },
};

export const assetObjectAttachmentAddedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.attachment_added',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'Asset Object attachment added',
    de: 'Asset-Objekt-Anhang hinzugefügt',
  },
  description: {
    en: 'Fires when a file is attached to an asset object',
    de: 'Wird ausgelöst, wenn einem Asset-Objekt eine Datei angehängt wird',
  },
  icon: 'bx-paperclip',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      attachment: {
        type: 'object',
        title: 'Attachment',
        properties: {
          id: { type: 'string', title: 'Attachment ID' },
          file_name: { type: 'string', title: 'File name' },
          file_size: { type: 'number', title: 'File size (bytes)' },
          mime_type: { type: 'string', title: 'MIME type' },
        },
      },
      created_by: { type: 'string', title: 'Uploaded by (User ID)' },
    },
  },
};

export const assetObjectCommentAddedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.comment_added',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'Asset Object comment added',
    de: 'Asset-Objekt-Kommentar hinzugefügt',
  },
  description: {
    en: 'Fires when a comment is posted on an asset object',
    de: 'Wird ausgelöst, wenn ein Kommentar zu einem Asset-Objekt hinzugefügt wird',
  },
  icon: 'bx-comment',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
      authorUserId: {
        type: 'string',
        title: 'Author user ID',
        description: 'Only fire when posted by this user — leave blank for any',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      comment: {
        type: 'object',
        title: 'Comment',
        properties: {
          id: { type: 'string', title: 'Comment ID' },
          body: { type: 'string', title: 'Comment body' },
          author_id: { type: 'string', title: 'Author User ID' },
        },
      },
      created_by: { type: 'string', title: 'Posted by (User ID)' },
    },
  },
};

export const assetObjectAttachmentDeletedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.attachment_deleted',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'Asset Object attachment deleted',
    de: 'Asset-Objekt-Anhang gelöscht',
  },
  description: {
    en: 'Fires when a file attachment is removed from an asset object',
    de: 'Wird ausgelöst, wenn ein Anhang von einem Asset-Objekt entfernt wird',
  },
  icon: 'bx-paperclip',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      attachment: {
        type: 'object',
        title: 'Attachment',
        properties: {
          id: { type: 'string', title: 'Attachment ID' },
          file_name: { type: 'string', title: 'File name' },
        },
      },
      deleted_by: { type: 'string', title: 'Deleted by (User ID)' },
    },
  },
};

export const assetObjectCommentUpdatedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.comment_updated',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'Asset Object comment updated',
    de: 'Asset-Objekt-Kommentar aktualisiert',
  },
  description: {
    en: 'Fires when a comment on an asset object is edited',
    de: 'Wird ausgelöst, wenn ein Kommentar zu einem Asset-Objekt bearbeitet wird',
  },
  icon: 'bx-comment',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      comment: {
        type: 'object',
        title: 'Comment',
        properties: {
          id: { type: 'string', title: 'Comment ID' },
          body: { type: 'string', title: 'Comment body' },
          author_id: { type: 'string', title: 'Author User ID' },
        },
      },
      updated_by: { type: 'string', title: 'Updated by (User ID)' },
    },
  },
};

export const assetObjectCommentDeletedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.comment_deleted',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'Asset Object comment deleted',
    de: 'Asset-Objekt-Kommentar gelöscht',
  },
  description: {
    en: 'Fires when a comment is removed from an asset object',
    de: 'Wird ausgelöst, wenn ein Kommentar von einem Asset-Objekt entfernt wird',
  },
  icon: 'bx-comment',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      comment: {
        type: 'object',
        title: 'Comment',
        properties: {
          id: { type: 'string', title: 'Comment ID' },
          body: { type: 'string', title: 'Comment body' },
          author_id: { type: 'string', title: 'Author User ID' },
        },
      },
      deleted_by: { type: 'string', title: 'Deleted by (User ID)' },
    },
  },
};

export const assetObjectImageAddedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.image_added',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'Asset Object image added',
    de: 'Asset-Objekt-Bild hinzugefügt',
  },
  description: {
    en: 'Fires when a cover image is uploaded for an asset object',
    de: 'Wird ausgelöst, wenn ein Titelbild für ein Asset-Objekt hochgeladen wird',
  },
  icon: 'bx-image-add',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      image: {
        type: 'object',
        title: 'Image',
        properties: {
          path: { type: 'string', title: 'Storage path' },
        },
      },
      updated_by: { type: 'string', title: 'Updated by (User ID)' },
    },
  },
};

export const assetObjectImageRemovedTrigger: CatalogTrigger = {
  kind: 'app.asset_object.image_removed',
  category: 'app_event',
  type: 'trigger',
  label: {
    en: 'Asset Object image removed',
    de: 'Asset-Objekt-Bild entfernt',
  },
  description: {
    en: "Fires when an asset object's cover image is removed",
    de: 'Wird ausgelöst, wenn das Titelbild eines Asset-Objekts entfernt wird',
  },
  icon: 'bx-image-alt',
  configSchema: {
    type: 'object',
    properties: {
      schemaId: {
        type: 'string',
        title: 'Asset schema',
        description: 'Leave blank to fire for any asset schema',
      },
    },
  },
  outputSchema: {
    ...ASSET_OUTPUT,
    properties: {
      ...ASSET_OUTPUT.properties,
      image: {
        type: 'object',
        title: 'Image',
        properties: {
          previous_path: { type: 'string', title: 'Previous storage path' },
        },
      },
      updated_by: { type: 'string', title: 'Updated by (User ID)' },
    },
  },
};

export const formSubmittedTrigger: CatalogTrigger = {
  kind: 'app.form.submitted',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Form submitted', de: 'Formular gesendet' },
  description: {
    en: 'Fires when a form-builder form is submitted in this space',
    de: 'Wird ausgelöst, wenn in diesem Bereich ein Formular abgesendet wird',
  },
  icon: 'bx-list-check',
  configSchema: {
    type: 'object',
    properties: {
      // Optional. When omitted, fires for ANY form in the space. When set, the tick matches this
      // top-level `formId` against the event payload's top-level `formId` (deterministic — `form` and
      // `submission` both carry `form_id`, so a nested match would be ambiguous). An empty value must
      // be omitted from the stored filter, or `<uuid> === ''` could never match — enforced FE-side.
      formId: {
        type: 'string',
        title: 'Form',
        description: 'Leave blank to fire for any form in this space',
      },
      // Chooses how `{{ trigger.submission.data }}` reads when it lands in a later action's text
      // field. Applied at substitution time by the worker, so `data` stays a real object for
      // per-field access and Condition rules.
      answerFormat: {
        type: 'string',
        title: 'Answer format',
        enum: ['text', 'table', 'json'],
        default: 'text',
      },
    },
  },
  outputSchema: {
    type: 'object',
    properties: {
      formId: { type: 'string', title: 'Form ID' },
      spaceId: { type: 'string', title: 'Space ID' },
      organizationId: { type: 'string', title: 'Organization ID' },
      submission: {
        type: 'object',
        title: 'Submission',
        properties: {
          id: { type: 'string', title: 'Submission ID' },
          form_id: { type: 'string', title: 'Form ID' },
          submitted_by: { type: 'string', title: 'Submitted By (User ID)' },
          status: { type: 'string', title: 'Status' },
          created_at: { type: 'string', title: 'Created At' },
          // Answers keyed by field_key — reference with {{ trigger.submission.data.<field_key> }}.
          data: { type: 'object', title: 'Answers (by field key)' },
          field_snapshot: {
            type: 'array',
            title: 'Field snapshot (frozen field defs)',
          },
        },
      },
    },
  },
};

const FORM_LIFECYCLE_OUTPUT = {
  type: 'object',
  properties: {
    formId: { type: 'string', title: 'Form ID' },
    formName: { type: 'string', title: 'Form name' },
    form: {
      type: 'object',
      title: 'Form',
      properties: {
        id: { type: 'string', title: 'Form ID' },
        name: { type: 'string', title: 'Name' },
        status: { type: 'string', title: 'Status' },
        is_template: { type: 'boolean', title: 'Is template' },
      },
    },
  },
};

// Optional form filter shared by the update/delete lifecycle triggers. Blank ⇒ any form (the tick
// skips empty/`'any'` filter values). Top-level `formId` matches the event payload's top-level key.
const FORM_FILTER_PROPS = {
  formId: {
    type: 'string',
    title: 'Form',
    description: 'Leave blank to fire for any form in this space',
  },
};

export const formCreatedTrigger: CatalogTrigger = {
  kind: 'app.form.created',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Form created', de: 'Formular erstellt' },
  description: {
    en: 'Fires when a new form is created in this space',
    de: 'Wird ausgelöst, wenn in diesem Bereich ein neues Formular erstellt wird',
  },
  icon: 'bx-plus-circle',
  configSchema: { type: 'object', properties: {} },
  outputSchema: FORM_LIFECYCLE_OUTPUT,
};

export const formUpdatedTrigger: CatalogTrigger = {
  kind: 'app.form.updated',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Form updated', de: 'Formular aktualisiert' },
  description: {
    en: 'Fires when a form is edited (name, settings, status, or published)',
    de: 'Wird ausgelöst, wenn ein Formular bearbeitet wird',
  },
  icon: 'bx-edit',
  configSchema: { type: 'object', properties: { ...FORM_FILTER_PROPS } },
  outputSchema: FORM_LIFECYCLE_OUTPUT,
};

export const formDeletedTrigger: CatalogTrigger = {
  kind: 'app.form.deleted',
  category: 'app_event',
  type: 'trigger',
  label: { en: 'Form deleted', de: 'Formular gelöscht' },
  description: {
    en: 'Fires when a form is deleted in this space',
    de: 'Wird ausgelöst, wenn in diesem Bereich ein Formular gelöscht wird',
  },
  icon: 'bx-trash',
  configSchema: { type: 'object', properties: { ...FORM_FILTER_PROPS } },
  outputSchema: FORM_LIFECYCLE_OUTPUT,
};

export const appEventTriggers: CatalogTrigger[] = [
  formSubmittedTrigger,
  formCreatedTrigger,
  formUpdatedTrigger,
  formDeletedTrigger,
  taskCreatedTrigger,
  taskUpdatedTrigger,
  taskStatusChangedTrigger,
  workflowStatusReachedTrigger,
  taskAssignedTrigger,
  taskDeletedTrigger,
  taskCommentAddedTrigger,
  planCreatedTrigger,
  planPublishedTrigger,
  planBaselineActivatedTrigger,
  wikiPageCreatedTrigger,
  wikiPagePublishedTrigger,
  wikiPageUpdatedTrigger,
  processCreatedTrigger,
  processUpdatedTrigger,
  riskThresholdCrossedTrigger,
  riskRecalculatedTrigger,
  processRelationshipChangedTrigger,
  assetCreatedTrigger,
  assetUpdatedTrigger,
  assetRelationAddedTrigger,
  assetObjectCreatedTrigger,
  assetObjectUpdatedTrigger,
  assetObjectDeletedTrigger,
  assetObjectTypeChangedTrigger,
  assetObjectAttachmentAddedTrigger,
  assetObjectAttachmentDeletedTrigger,
  assetObjectCommentAddedTrigger,
  assetObjectCommentUpdatedTrigger,
  assetObjectCommentDeletedTrigger,
  assetObjectImageAddedTrigger,
  assetObjectImageRemovedTrigger,
  gdprRecordAddedTrigger,
  userInvitedTrigger,
  spaceMemberAddedTrigger,
  wikiRelationAddedTrigger,
  taskRelationAddedTrigger,
  taskAttachmentAddedTrigger,
  taskTimeLoggedTrigger,
];
