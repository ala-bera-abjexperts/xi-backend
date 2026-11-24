import { Injectable } from '@nestjs/common';

export interface CatalogAction {
  kind: string;
  category: 'integration' | 'app_mutation' | 'control';
  type: 'action' | 'control';
  label: { en: string; de?: string };
  description?: { en: string; de?: string };
  icon: string;
  configSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  requiresConnection?: string;
}

const TEMPLATE = { 'x-field-type': 'template' } as const;

// The task-action output shown in the variable picker. `key` was missing even though the handlers
// have always returned it, so a downstream message step could only reference the UUID.
const TASK_OUTPUT = {
  type: 'object',
  properties: {
    key: { type: 'string', title: 'Task Key' },
    summary: { type: 'string', title: 'Summary' },
    id: { type: 'string', title: 'Task ID (UUID)' },
    status: { type: 'string', title: 'Status' },
    space_id: { type: 'string', title: 'Space ID' },
  },
};

const CATALOG: CatalogAction[] = [
  // App Mutations

  {
    kind: 'app.task.create',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Create task' },
    icon: 'bx-plus-circle',
    configSchema: {
      type: 'object',
      properties: {
        summary: {
          type: 'string',
          title: 'Summary',
          description: 'Task title. Use {{ trigger.field }} for dynamic values',
          ...TEMPLATE,
        },
        description: {
          type: 'string',
          title: 'Description',
          description: 'Optional longer description or acceptance criteria',
          ...TEMPLATE,
        },
        status: {
          type: 'string',
          title: 'Status',
          'x-field-type': 'status-key-picker',
          description: 'Initial status — leave blank to use the default (open)',
        },
        priority: {
          type: 'string',
          title: 'Priority',
          'x-field-type': 'priority-picker',
          description:
            'Task priority — leave blank to use the default (medium)',
        },
        taskType: {
          type: 'string',
          title: 'Task type',
          'x-field-type': 'task-type-picker',
          description: 'Leave blank to use the default (task)',
        },
        assignedTo: {
          type: 'string',
          title: 'Assigned to',
          description: 'User ID or {{ trigger.task.assigned_to }}',
        },
        dueDate: {
          type: 'string',
          title: 'Due date',
          description: 'ISO date or {{ trigger.task.due_date }}',
          ...TEMPLATE,
        },
        parentTaskId: {
          type: 'string',
          title: 'Parent task',
          description:
            'Task ID or {{ trigger.task.id }} — leave blank for a root task',
          ...TEMPLATE,
        },
        customFieldValues: {
          type: 'object',
          title: 'Custom fields',
          description: 'Set values for space custom fields on the created task',
          'x-field-type': 'custom-fields-mapper',
          'x-scope-by': 'taskType',
        },
      },
      required: ['summary'],
    },
    outputSchema: { type: 'object', properties: { task: TASK_OUTPUT } },
  },

  {
    kind: 'app.task.update',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Update task' },
    icon: 'bx-edit',
    configSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          title: 'Task ID',
          description: 'Task ID or {{ trigger.task.id }}',
        },
        summary: { type: 'string', title: 'Summary', ...TEMPLATE },
        description: { type: 'string', title: 'Description', ...TEMPLATE },
        status: {
          type: 'string',
          title: 'New status',
          'x-field-type': 'status-key-picker',
        },
        priority: {
          type: 'string',
          title: 'New priority',
          'x-field-type': 'priority-picker',
        },
        assignedTo: {
          type: 'string',
          title: 'Assigned to',
          description: 'User ID or {{ trigger.task.assigned_to }}',
        },
        dueDate: {
          type: 'string',
          title: 'Due date',
          description: 'Leave blank to keep current',
          ...TEMPLATE,
        },
        taskType: {
          type: 'string',
          title: 'Task type',
          description:
            'Chooses which custom fields are offered below. The task keeps its own type.',
          'x-field-type': 'task-type-picker',
        },
        customFieldValues: {
          type: 'object',
          title: 'Custom fields',
          description:
            'Set values for space custom fields on the updated task — blank leaves the current value',
          'x-field-type': 'custom-fields-mapper',
          'x-scope-by': 'taskType',
        },
      },
      required: ['taskId'],
    },
    outputSchema: { type: 'object', properties: { task: TASK_OUTPUT } },
  },

  {
    kind: 'app.task.assign',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Assign task' },
    icon: 'bx-user-check',
    configSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          title: 'Task ID',
          description: 'Task ID or {{ trigger.task.id }}',
        },
        userId: {
          type: 'string',
          title: 'User ID',
          description: 'User ID or {{ trigger.task.assigned_to }}',
        },
      },
      required: ['taskId', 'userId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            assigned_to: { type: 'string', title: 'Assigned to' },
          },
        },
      },
    },
  },

  {
    kind: 'app.task.add_comment',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Add task comment' },
    icon: 'bx-comment-add',
    configSchema: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          title: 'Task ID',
          description: 'Task ID or {{ trigger.task.id }}',
        },
        body: { type: 'string', title: 'Comment body', ...TEMPLATE },
      },
      required: ['taskId', 'body'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        comment: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            body: { type: 'string', title: 'Body' },
            task_id: { type: 'string', title: 'Task ID' },
          },
        },
      },
    },
  },

  {
    kind: 'app.risk.update',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Update risk score' },
    icon: 'bx-error-alt',
    configSchema: {
      type: 'object',
      properties: {
        processId: {
          type: 'string',
          title: 'Process ID',
          description: 'Business process ID — use {{ trigger.process.id }}',
        },
        score: {
          type: 'number',
          title: 'Risk score',
          minimum: 0,
          maximum: 100,
          description: 'Risk score from 0 to 100',
        },
        notes: {
          type: 'string',
          title: 'Notes',
          description: 'Optional notes',
          ...TEMPLATE,
        },
      },
      required: ['processId', 'score'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            name: { type: 'string', title: 'Name' },
            risk_score: { type: 'number', title: 'Risk score' },
          },
        },
      },
    },
  },

  {
    kind: 'app.wiki.create_page',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Create wiki page' },
    icon: 'bx-book-add',
    configSchema: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          title: 'Space ID',
          description: 'Space ID — use {{ context.spaceId }}',
        },
        title: { type: 'string', title: 'Page title', ...TEMPLATE },
        content: {
          type: 'string',
          title: 'Page content',
          description: 'Initial page content — HTML or plain text',
          ...TEMPLATE,
        },
        parentId: {
          type: 'string',
          title: 'Parent page ID',
          description: 'Parent page ID for nesting — leave blank for top-level',
        },
      },
      required: ['spaceId', 'title'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            title: { type: 'string', title: 'Title' },
            space_id: { type: 'string', title: 'Space ID' },
          },
        },
      },
    },
  },

  {
    kind: 'app.wiki.update_page',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Update wiki page' },
    icon: 'bx-book-open',
    configSchema: {
      type: 'object',
      properties: {
        pageId: {
          type: 'string',
          title: 'Page ID',
          description: 'Wiki page ID — use {{ trigger.page.id }}',
        },
        title: {
          type: 'string',
          title: 'New title',
          description: 'Leave blank to keep current',
          ...TEMPLATE,
        },
        content: {
          type: 'string',
          title: 'New content',
          description: 'Page content — leave blank to keep current',
          ...TEMPLATE,
        },
      },
      required: ['pageId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        page: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            title: { type: 'string', title: 'Title' },
            space_id: { type: 'string', title: 'Space ID' },
          },
        },
      },
    },
  },

  {
    kind: 'app.process.update',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Update process' },
    icon: 'bx-git-branch',
    configSchema: {
      type: 'object',
      properties: {
        processId: {
          type: 'string',
          title: 'Process ID',
          description: 'Use {{ trigger.process.id }}',
        },
        fields: {
          type: 'object',
          title: 'Fields to update',
          description: 'JSON object of field key → new value pairs',
        },
      },
      required: ['processId', 'fields'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        process: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            name: { type: 'string', title: 'Name' },
            space_id: { type: 'string', title: 'Space ID' },
          },
        },
      },
    },
  },

  {
    kind: 'app.notification.create',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Create notification' },
    icon: 'bx-bell',
    configSchema: {
      type: 'object',
      properties: {
        userId: {
          type: 'string',
          title: 'User ID',
          description: 'User ID to notify — use {{ trigger.task.assigned_to }}',
        },
        type: {
          type: 'string',
          title: 'Notification type',
          description: 'Category key — e.g. "task_assigned"',
        },
        title: {
          type: 'string',
          title: 'Title',
          description: 'Short notification title',
          ...TEMPLATE,
        },
        body: {
          type: 'string',
          title: 'Message body',
          description: 'Optional longer message body',
          ...TEMPLATE,
        },
        referenceType: {
          type: 'string',
          title: 'Reference type',
          description: 'Entity type — e.g. "task"',
        },
        referenceId: {
          type: 'string',
          title: 'Reference ID',
          description: 'e.g. {{ trigger.task.id }}',
        },
      },
      required: ['userId', 'type', 'title'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        notification: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            type: { type: 'string', title: 'Type' },
            title: { type: 'string', title: 'Title' },
          },
        },
      },
    },
  },

  {
    kind: 'app.audit.log',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Write audit log' },
    icon: 'bx-clipboard',
    configSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          title: 'Entity type',
          description: 'e.g. task, risk, process',
        },
        entityId: {
          type: 'string',
          title: 'Entity ID',
          description: 'ID of the entity being logged',
        },
        action: {
          type: 'string',
          title: 'Action',
          description: 'e.g. task.created, risk.updated',
        },
        changes: {
          type: 'object',
          title: 'Changes',
          description: 'JSON object describing what changed',
        },
      },
      required: ['action'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        log: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            entity_type: { type: 'string', title: 'Entity type' },
            action: { type: 'string', title: 'Action' },
          },
        },
      },
    },
  },

  {
    kind: 'app.plan.create',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Create plan' },
    icon: 'bx-calendar-plus',
    configSchema: {
      type: 'object',
      properties: {
        spaceId: {
          type: 'string',
          title: 'Space ID',
          description:
            'Space to create the plan in — use {{ context.spaceId }}',
        },
        name: { type: 'string', title: 'Plan name', ...TEMPLATE },
        description: { type: 'string', title: 'Description', ...TEMPLATE },
        startDate: {
          type: 'string',
          title: 'Start date',
          description: 'ISO datetime or {{ trigger.date }}',
          ...TEMPLATE,
        },
        endDate: {
          type: 'string',
          title: 'End date',
          description: 'ISO datetime or {{ trigger.date }}',
          ...TEMPLATE,
        },
      },
      required: ['spaceId', 'name'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        plan: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            name: { type: 'string', title: 'Name' },
            space_id: { type: 'string', title: 'Space ID' },
          },
        },
      },
    },
  },

  // Control

  {
    kind: 'control.condition',
    category: 'control',
    type: 'control',
    label: { en: 'Condition (If/Else)' },
    icon: 'bx-git-branch',
    configSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          title: 'Condition expression',
          format: 'jexl',
          description: 'Returns true (Yes branch) or false (No branch)',
        },
        filterRules: {
          type: 'string',
          title: 'Filter rules',
          description:
            'JSON-serialized rule group (managed by the visual query builder)',
        },
      },
      required: [],
    },
    outputSchema: { type: 'object', properties: {} },
  },

  {
    kind: 'control.wait',
    category: 'control',
    type: 'control',
    label: { en: 'Wait' },
    icon: 'bx-time-five',
    configSchema: {
      type: 'object',
      properties: {
        duration: {
          type: 'string',
          title: 'Duration',
          description: 'How long to wait — e.g. "30m", "2h", "1d"',
        },
      },
      required: ['duration'],
    },
    outputSchema: { type: 'object', properties: {} },
  },

  {
    kind: 'control.loop',
    category: 'control',
    type: 'control',
    label: { en: 'Loop' },
    icon: 'bx-refresh',
    configSchema: {
      type: 'object',
      properties: {
        overField: {
          type: 'string',
          title: 'Items array path',
          description:
            'Field path to the array to iterate — e.g. "trigger.tasks"',
        },
        maxIterations: {
          type: 'integer',
          title: 'Max iterations',
          minimum: 1,
          maximum: 1000,
          default: 100,
        },
      },
      required: ['overField'],
    },
    outputSchema: { type: 'object', properties: {} },
  },

  {
    kind: 'control.filter',
    category: 'control',
    type: 'control',
    label: { en: 'Filter' },
    icon: 'bx-filter',
    configSchema: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          title: 'Filter expression',
          format: 'jexl',
          description: 'Only continue if expression evaluates to true',
        },
        filterRules: {
          type: 'string',
          title: 'Filter rules',
          description:
            'JSON-serialized rule group (managed by the visual query builder)',
        },
      },
      required: [],
    },
    outputSchema: { type: 'object', properties: {} },
  },

  {
    kind: 'control.parallel',
    category: 'control',
    type: 'control',
    label: { en: 'Parallel' },
    icon: 'bx-git-merge',
    configSchema: {
      type: 'object',
      properties: {
        waitForAll: {
          type: 'boolean',
          title: 'Wait for all branches',
          description:
            'When enabled, waits for both branches before continuing',
        },
      },
    },
    outputSchema: { type: 'object', properties: {} },
  },

  // Integrations

  {
    kind: 'integration.slack.send_message',
    category: 'integration',
    type: 'action',
    label: { en: 'Send Slack message' },
    icon: 'bx-hash',
    requiresConnection: 'slack',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Slack Account',
          description: 'Leave blank to use your default connected account',
        },
        channelId: {
          type: 'string',
          title: 'Channel ID',
          description: 'Slack channel ID (e.g. C07ABC123)',
        },
        text: {
          type: 'string',
          title: 'Message',
          'x-field-type': 'template',
          description:
            'Message text. Use {{ trigger.field }} for dynamic values',
        },
        threadTs: {
          type: 'string',
          title: 'Thread Timestamp',
          description: 'Reply in a thread — paste the message timestamp',
        },
      },
      required: ['channelId', 'text'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'OK' },
        ts: { type: 'string', title: 'Message timestamp' },
        channel: { type: 'string', title: 'Channel' },
      },
    },
  },

  {
    kind: 'integration.email.send',
    category: 'integration',
    type: 'action',
    label: { en: 'Send email' },
    icon: 'bx-envelope',
    requiresConnection: 'email',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Email Account',
          description: 'Leave blank to use your default connected account',
        },
        to: {
          type: 'string',
          title: 'To',
          'x-field-type': 'template',
          description:
            'Recipient email address. Use {{ trigger.field }} for dynamic values',
        },
        subject: {
          type: 'string',
          title: 'Subject',
          'x-field-type': 'template',
          description: 'Email subject line',
        },
        body: {
          type: 'string',
          title: 'Body',
          'x-field-type': 'template',
          description: 'Email body (HTML supported)',
        },
        cc: { type: 'string', title: 'CC', description: 'CC email address' },
        replyTo: {
          type: 'string',
          title: 'Reply-To',
          description: 'Reply-to email address',
        },
      },
      required: ['to', 'subject', 'body'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'OK' },
        messageId: { type: 'string', title: 'Message ID' },
      },
    },
  },

  {
    kind: 'integration.webhook.outbound',
    category: 'integration',
    type: 'action',
    label: { en: 'Call webhook URL' },
    icon: 'bx-link',
    configSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          title: 'URL',
          description: 'HTTPS URL to call — must be a public HTTPS endpoint',
        },
        method: {
          type: 'string',
          title: 'Method',
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
          default: 'POST',
          description: 'HTTP method to use',
        },
        headers: {
          type: 'object',
          title: 'Headers',
          description: 'Extra request headers as JSON',
        },
        body: {
          type: 'string',
          title: 'Body',
          'x-field-type': 'template',
          description:
            'Request body — JSON object or raw string. Use {{ trigger.field }} for dynamic values',
        },
        timeoutMs: {
          type: 'number',
          title: 'Timeout (ms)',
          minimum: 1000,
          maximum: 30000,
          default: 10000,
          description: 'Request timeout in milliseconds (1000–30000)',
        },
      },
      required: ['url'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'OK' },
        status: { type: 'number', title: 'HTTP status' },
        body: { type: 'string', title: 'Response body' },
      },
    },
  },

  {
    kind: 'integration.github.create_issue',
    category: 'integration',
    type: 'action',
    label: { en: 'Create GitHub issue' },
    icon: 'bx-bxl-github',
    requiresConnection: 'github',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'GitHub Account',
          description: 'Leave blank to use your default connected account',
        },
        owner: {
          type: 'string',
          title: 'Owner',
          description: 'GitHub username or organisation (e.g. "acme-corp")',
        },
        repo: {
          type: 'string',
          title: 'Repository',
          description: 'Repository name (e.g. "my-app")',
        },
        title: {
          type: 'string',
          title: 'Title',
          'x-field-type': 'template',
          description:
            'Issue title. Use {{ trigger.field }} for dynamic values',
        },
        body: {
          type: 'string',
          title: 'Body',
          'x-field-type': 'template',
          description:
            'Issue body (Markdown). Use {{ trigger.field }} for dynamic values',
        },
        labels: {
          type: 'array',
          title: 'Labels',
          items: { type: 'string' },
          description: 'Label names to apply',
        },
      },
      required: ['owner', 'repo', 'title'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        number: { type: 'integer', title: 'Issue number' },
        url: { type: 'string', title: 'Issue URL' },
      },
    },
  },

  {
    kind: 'integration.jira.create_issue',
    category: 'integration',
    type: 'action',
    label: { en: 'Create Jira issue' },
    icon: 'bx-bug',
    requiresConnection: 'jira',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Jira Account',
          description: 'Leave blank to use your default connected account',
        },
        projectKey: {
          type: 'string',
          title: 'Project',
          description: 'Jira project key (e.g. "PROJ")',
        },
        summary: {
          type: 'string',
          title: 'Summary',
          'x-field-type': 'template',
          description:
            'Issue summary / title. Use {{ trigger.field }} for dynamic values',
        },
        description: {
          type: 'string',
          title: 'Description',
          'x-field-type': 'template',
          description: 'Issue description',
        },
        issueType: {
          type: 'string',
          title: 'Issue Type',
          default: 'Task',
          description: 'e.g. "Task", "Bug", "Story"',
        },
      },
      required: ['projectKey', 'summary'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', title: 'Issue ID' },
        key: { type: 'string', title: 'Issue key' },
        url: { type: 'string', title: 'Issue URL' },
      },
    },
  },

  {
    kind: 'integration.google_calendar.create_event',
    category: 'integration',
    type: 'action',
    label: { en: 'Create calendar event' },
    icon: 'bx-calendar-event',
    requiresConnection: 'google_calendar',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Google Calendar Account',
          description: 'Leave blank to use your default connected account',
        },
        calendarId: {
          type: 'string',
          title: 'Calendar',
          default: 'primary',
          description: 'Calendar ID — use "primary" for default',
        },
        summary: {
          type: 'string',
          title: 'Event Title',
          'x-field-type': 'template',
          description:
            'Event title. Use {{ trigger.field }} for dynamic values',
        },
        start: {
          type: 'string',
          title: 'Start',
          'x-field-type': 'template',
          description: 'ISO datetime — e.g. 2026-06-01T10:00:00Z',
        },
        end: {
          type: 'string',
          title: 'End',
          'x-field-type': 'template',
          description:
            'ISO datetime — e.g. 2026-06-01T11:00:00Z. Leave blank to use the duration below',
        },
        durationMinutes: {
          type: 'number',
          title: 'Duration (minutes)',
          default: 60,
          description:
            'Used when End is blank or is not after Start — Google rejects a zero-length event',
        },
        description: {
          type: 'string',
          title: 'Description',
          'x-field-type': 'template',
          description: 'Event description',
        },
        attendees: {
          type: 'array',
          title: 'Attendees',
          items: { type: 'string', format: 'email' },
          description: 'Attendee email addresses — press Enter after each one',
        },
        timezone: {
          type: 'string',
          title: 'Timezone',
          default: 'UTC',
          description: 'IANA timezone (e.g. America/New_York)',
        },
      },
      required: ['summary', 'start'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'OK' },
        eventId: { type: 'string', title: 'Event ID' },
        htmlLink: { type: 'string', title: 'Event link' },
      },
    },
  },

  // Teams
  {
    kind: 'integration.teams.send_message',
    category: 'integration',
    type: 'action',
    label: { en: 'Send Teams message' },
    icon: 'bx-message-square',
    requiresConnection: 'teams',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Teams Account',
          description: 'Leave blank to use your default connected account',
        },
        teamId: {
          type: 'string',
          title: 'Team',
          description: 'The Microsoft Teams team to post to',
        },
        channelId: {
          type: 'string',
          title: 'Channel',
          description: 'The channel within the selected team',
        },
        title: {
          type: 'string',
          title: 'Title (optional)',
          description: 'Optional subject displayed in bold above the message',
        },
        message: {
          type: 'string',
          title: 'Message',
          'x-field-type': 'template',
          description:
            'Message text. HTML supported. Use {{ trigger.field }} for dynamic values',
        },
      },
      required: ['teamId', 'channelId', 'message'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'OK' },
        messageId: { type: 'string', title: 'Message ID' },
      },
    },
  },

  // Notion
  {
    kind: 'integration.notion.create_page',
    category: 'integration',
    type: 'action',
    label: { en: 'Create Notion page' },
    icon: 'bx-note',
    requiresConnection: 'notion',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Notion Account',
          description: 'Leave blank to use your default connected account',
        },
        databaseId: {
          type: 'string',
          title: 'Database',
          description: 'Notion database ID — select from the dropdown above',
        },
        properties: {
          type: 'string',
          title: 'Page Properties',
          'x-field-type': 'template',
          description:
            'JSON object of page properties. Use {{ trigger.* }} in string values.',
        },
      },
      required: ['databaseId', 'properties'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'OK' },
        pageId: { type: 'string', title: 'Page ID' },
        pageUrl: { type: 'string', title: 'Page URL' },
      },
    },
  },

  // Linear
  {
    kind: 'integration.linear.create_issue',
    category: 'integration',
    type: 'action',
    label: { en: 'Create Linear issue' },
    icon: 'bx-git-pull-request',
    requiresConnection: 'linear',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Linear Account',
          description: 'Leave blank to use your default connected account',
        },
        teamId: {
          type: 'string',
          title: 'Team',
          description: 'The Linear team to create the issue in',
        },
        title: {
          type: 'string',
          title: 'Title',
          'x-field-type': 'template',
          description:
            'Issue title. Use {{ trigger.field }} for dynamic values',
        },
        description: {
          type: 'string',
          title: 'Description',
          'x-field-type': 'template',
          description: 'Issue description (Markdown supported)',
        },
        priority: {
          type: 'string',
          title: 'Priority',
          enum: ['0', '1', '2', '3', '4'],
          default: '0',
          description:
            '0 = No priority, 1 = Urgent, 2 = High, 3 = Medium, 4 = Low',
        },
      },
      required: ['teamId', 'title'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', title: 'Issue ID' },
        identifier: { type: 'string', title: 'Issue identifier' },
        url: { type: 'string', title: 'Issue URL' },
      },
    },
  },
  {
    kind: 'integration.clickup.create_task',
    category: 'integration',
    type: 'action',
    label: { en: 'Create ClickUp Task' },
    icon: 'bx-task',
    requiresConnection: 'clickup',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'ClickUp Account',
          description: 'Leave blank to use your default connected account',
        },
        listId: {
          type: 'string',
          title: 'List',
          description: 'The ClickUp list to create the task in',
        },
        name: {
          type: 'string',
          title: 'Task Name',
          'x-field-type': 'template',
          description: 'Task name. Use {{ trigger.field }} for dynamic values',
        },
        description: {
          type: 'string',
          title: 'Description',
          'x-field-type': 'template',
          description: 'Task description (optional)',
        },
        priority: {
          type: 'string',
          title: 'Priority',
          enum: ['1', '2', '3', '4'],
          description: '1 = Urgent, 2 = High, 3 = Normal, 4 = Low',
        },
        customFields: {
          type: 'string',
          title: 'Custom Fields',
          'x-field-type': 'clickup-field-mapper',
        },
      },
      required: ['listId', 'name'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', title: 'Task ID' },
        url: { type: 'string', title: 'Task URL' },
      },
    },
  },
  {
    kind: 'integration.asana.create_task',
    category: 'integration',
    type: 'action',
    label: { en: 'Create Asana Task' },
    icon: 'bx-task',
    requiresConnection: 'asana',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Asana Account',
          description: 'Leave blank to use your default connected account',
        },
        workspaceId: {
          type: 'string',
          title: 'Workspace',
          description: 'Select the Asana workspace',
        },
        projectId: {
          type: 'string',
          title: 'Project',
          description: 'Select the Asana project',
        },
        name: {
          type: 'string',
          title: 'Task Name',
          'x-field-type': 'template',
          description: 'Task name. Use {{ trigger.field }} for dynamic values',
        },
        notes: {
          type: 'string',
          title: 'Description',
          'x-field-type': 'template',
          description: 'Task notes / description (optional)',
        },
        assignee: {
          type: 'string',
          title: 'Assignee',
          description: 'Select an Asana team member (optional)',
        },
        dueDate: {
          type: 'string',
          title: 'Due Date',
          description: 'ISO date string (YYYY-MM-DD)',
        },
        customFields: {
          type: 'string',
          title: 'Custom Fields',
          'x-field-type': 'asana-custom-fields-mapper',
        },
      },
      required: ['workspaceId', 'name'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        gid: { type: 'string', title: 'Task GID' },
        permalink_url: { type: 'string', title: 'Task URL' },
      },
    },
  },
  {
    kind: 'integration.discord.post_webhook',
    category: 'integration',
    type: 'action',
    label: { en: 'Post Discord message' },
    icon: 'bx-message-square-dots',
    requiresConnection: 'discord',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Discord Webhook',
          description: 'Leave blank to use your default connected webhook',
        },
        content: {
          type: 'string',
          title: 'Message content',
          'x-field-type': 'template',
          description:
            'Message text (max 2000 chars). Use {{ trigger.field }} for dynamic values',
        },
        username: {
          type: 'string',
          title: 'Override username',
          description:
            'Override the webhook display name — leave blank for default',
        },
        embeds: {
          type: 'array',
          title: 'Embeds (JSON)',
          items: { type: 'object' },
          description: 'Optional Discord embed objects array',
        },
      },
      required: ['content'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'OK' },
        messageId: { type: 'string', title: 'Message ID' },
      },
    },
  },

  {
    kind: 'integration.google_sheets.append_row',
    category: 'integration',
    type: 'action',
    label: { en: 'Append row to Google Sheet' },
    icon: 'bx-table',
    requiresConnection: 'google_sheets',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Google Account',
          description: 'Leave blank to use your default connected account',
        },
        spreadsheetId: {
          type: 'string',
          title: 'Spreadsheet',
          description: 'Select the Google Spreadsheet',
        },
        range: {
          type: 'string',
          title: 'Sheet / Range',
          description: 'Sheet name or A1 range (e.g. Sheet1 or Sheet1!A:Z)',
        },
        values: {
          type: 'string',
          title: 'Row values',
          'x-field-type': 'template',
          description:
            'Comma-separated values for the row. Use {{ trigger.field }} for dynamic values',
        },
      },
      required: ['spreadsheetId', 'range', 'values'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'OK' },
        updatedRange: { type: 'string', title: 'Updated range' },
        updatedRows: { type: 'number', title: 'Rows updated' },
      },
    },
  },

  {
    kind: 'integration.airtable.create_record',
    category: 'integration',
    type: 'action',
    label: { en: 'Airtable record action' },
    icon: 'bx-grid-alt',
    requiresConnection: 'airtable',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Airtable Account',
          description: 'Leave blank to use your default connected account',
        },
        actionType: {
          type: 'string',
          title: 'Action',
          enum: [
            'create_record',
            'update_record',
            'get_record',
            'list_records',
            'delete_record',
            'upsert_record',
          ],
          default: 'create_record',
          description: 'The operation to perform on the Airtable table',
        },
        baseId: {
          type: 'string',
          title: 'Base',
          description: 'Select the Airtable base',
        },
        tableIdOrName: {
          type: 'string',
          title: 'Table',
          description: 'Select the table within the base',
        },
        fieldMappings: {
          type: 'array',
          title: 'Field mappings',
          items: { type: 'object' },
          description: 'Map table fields to values',
        },
        recordId: {
          type: 'string',
          title: 'Record ID',
          description: 'Required for update, get, and delete actions',
        },
        fieldsToMergeOn: {
          type: 'array',
          title: 'Merge on fields',
          items: { type: 'string' },
          description:
            'Required for upsert — field names to match existing records',
        },
        filterByFormula: {
          type: 'string',
          title: 'Filter formula',
          description: 'Airtable formula to filter records (list action only)',
        },
        maxRecords: {
          type: 'integer',
          title: 'Max records',
          minimum: 1,
          maximum: 100,
          default: 10,
          description: 'Maximum number of records to return (list action only)',
        },
        view: {
          type: 'string',
          title: 'View',
          description: 'Optional view name to use for listing',
        },
        typecast: {
          type: 'boolean',
          title: 'Typecast',
          description:
            'Auto-convert string values to the appropriate field types',
        },
      },
      required: ['actionType', 'baseId', 'tableIdOrName'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'OK' },
        recordId: { type: 'string', title: 'Record ID' },
        records: { type: 'array', title: 'Records' },
        deleted: { type: 'boolean', title: 'Deleted' },
      },
    },
  },

  {
    kind: 'integration.trello.create_card',
    category: 'integration',
    type: 'action',
    label: { en: 'Create Trello Card' },
    icon: 'bx-credit-card',
    requiresConnection: 'trello',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Trello Account',
          description: 'Leave blank to use your default connected account',
        },
        listId: {
          type: 'string',
          title: 'List',
          description: 'The Trello list to create the card in',
        },
        name: {
          type: 'string',
          title: 'Card Name',
          'x-field-type': 'template',
          description: 'Card title. Use {{ trigger.field }} for dynamic values',
        },
        desc: {
          type: 'string',
          title: 'Description',
          'x-field-type': 'template',
          description: 'Card description (optional)',
        },
        due: {
          type: 'string',
          title: 'Due Date',
          description: 'ISO date string (optional)',
        },
      },
      required: ['listId', 'name'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', title: 'Card ID' },
        shortUrl: { type: 'string', title: 'Card URL' },
      },
    },
  },
  {
    kind: 'integration.salesforce.create_lead',
    category: 'integration',
    type: 'action',
    label: { en: 'Create Salesforce Lead', de: 'Salesforce-Lead erstellen' },
    description: {
      en: 'Creates a lead record in Salesforce CRM',
      de: 'Erstellt einen Lead-Datensatz in Salesforce CRM',
    },
    icon: 'bx-user-plus',
    requiresConnection: 'salesforce',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Salesforce Account',
          description: 'Leave blank to use your default connected account',
        },
        firstName: {
          type: 'string',
          title: 'First name',
          'x-field-type': 'template',
          description: 'Lead first name',
        },
        lastName: {
          type: 'string',
          title: 'Last name',
          'x-field-type': 'template',
          description: 'Lead last name — required by Salesforce',
        },
        company: {
          type: 'string',
          title: 'Company',
          'x-field-type': 'template',
          description: 'Company name — required by Salesforce',
        },
        email: {
          type: 'string',
          title: 'Email',
          'x-field-type': 'template',
          description: 'Lead email address',
        },
        phone: {
          type: 'string',
          title: 'Phone',
          'x-field-type': 'template',
          description: 'Lead phone number',
        },
        description: {
          type: 'string',
          title: 'Description',
          'x-field-type': 'template',
          description:
            'Additional notes. Use {{ trigger.field }} for dynamic values',
        },
      },
      required: ['lastName', 'company'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', title: 'Lead ID' },
        success: { type: 'boolean', title: 'Success' },
      },
    },
  },
  {
    kind: 'integration.twilio.send_sms',
    category: 'integration',
    type: 'action',
    label: { en: 'Send SMS via Twilio', de: 'SMS über Twilio senden' },
    description: {
      en: 'Sends an SMS message via the Twilio API',
      de: 'Sendet eine SMS-Nachricht über die Twilio-API',
    },
    icon: 'bx-mobile',
    requiresConnection: 'twilio',
    configSchema: {
      type: 'object',
      properties: {
        connectionId: {
          type: 'string',
          title: 'Twilio Account',
          description: 'Leave blank to use your default connected account',
        },
        to: {
          type: 'string',
          title: 'To',
          'x-field-type': 'template',
          description:
            'Recipient phone number in E.164 format — e.g. +14155552671',
        },
        from: {
          type: 'string',
          title: 'From',
          'x-field-type': 'template',
          description: 'Your Twilio phone number in E.164 format',
        },
        body: {
          type: 'string',
          title: 'Message',
          'x-field-type': 'template',
          description:
            'SMS message body. Use {{ trigger.field }} for dynamic values',
        },
      },
      required: ['to', 'from', 'body'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        sid: { type: 'string', title: 'Message SID' },
        status: { type: 'string', title: 'Status' },
      },
    },
  },

  // Asset Object app mutations
  {
    kind: 'app.asset_object.create',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Create Asset Object' },
    icon: 'bx-cube-alt',
    configSchema: {
      type: 'object',
      properties: {
        schemaId: { type: 'string', title: 'Asset schema' },
        objectTypeId: { type: 'string', title: 'Object type' },
        name: { type: 'string', title: 'Name' },
        description: { type: 'string', title: 'Description' },
        attributeValues: { type: 'object', title: 'Attribute values' },
      },
      required: ['schemaId', 'objectTypeId', 'name'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        asset: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            object_key: { type: 'string', title: 'Object key' },
            name: { type: 'string', title: 'Name' },
          },
        },
      },
    },
  },

  {
    kind: 'app.asset_object.update',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Update Asset Object' },
    icon: 'bx-cube',
    configSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          title: 'Asset ID',
          description: 'Asset ID or {{ trigger.asset_id }}',
        },
        name: { type: 'string', title: 'Name' },
        description: { type: 'string', title: 'Description' },
        attributeValues: { type: 'object', title: 'Attribute values' },
      },
      required: ['assetId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        asset: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            name: { type: 'string', title: 'Name' },
          },
        },
      },
    },
  },

  {
    kind: 'app.asset_object.delete',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Delete Asset Object' },
    icon: 'bx-trash',
    configSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          title: 'Asset ID',
          description: 'Asset ID or {{ trigger.asset_id }}',
        },
      },
      required: ['assetId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', title: 'Success' },
        asset_id: { type: 'string', title: 'Asset ID' },
      },
    },
  },

  {
    kind: 'app.asset_object.change_type',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Change Asset Object type' },
    icon: 'bx-transfer',
    configSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          title: 'Asset ID',
          description: 'Asset ID or {{ trigger.asset_id }}',
        },
        newObjectTypeId: { type: 'string', title: 'New object type' },
      },
      required: ['assetId', 'newObjectTypeId'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        asset: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            object_type_id: { type: 'string', title: 'Object type ID' },
          },
        },
      },
    },
  },

  {
    kind: 'app.asset_object.add_comment',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Add Asset Object comment' },
    icon: 'bx-comment-add',
    configSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          title: 'Asset ID',
          description: 'Asset ID or {{ trigger.asset_id }}',
        },
        body: { type: 'string', title: 'Comment body', ...TEMPLATE },
      },
      required: ['assetId', 'body'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        comment: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            body: { type: 'string', title: 'Body' },
            asset_id: { type: 'string', title: 'Asset ID' },
          },
        },
      },
    },
  },

  {
    kind: 'app.asset_object.add_attachment',
    category: 'app_mutation',
    type: 'action',
    label: { en: 'Add Asset Object attachment' },
    icon: 'bx-paperclip',
    configSchema: {
      type: 'object',
      properties: {
        assetId: {
          type: 'string',
          title: 'Asset ID',
          description: 'Asset ID or {{ trigger.asset_id }}',
        },
        fileUrl: { type: 'string', title: 'File URL' },
        fileName: { type: 'string', title: 'File name' },
      },
      required: ['assetId', 'fileUrl'],
    },
    outputSchema: {
      type: 'object',
      properties: {
        attachment: {
          type: 'object',
          properties: {
            id: { type: 'string', title: 'ID' },
            file_name: { type: 'string', title: 'File name' },
          },
        },
      },
    },
  },
];

@Injectable()
export class AutomationCatalogService {
  getCatalog(): CatalogAction[] {
    return CATALOG;
  }
}
