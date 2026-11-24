export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  category: 'notifications' | 'scheduling' | 'integrations' | 'internal';
  tags: string[];
  icon: string;
  svgIcon?: string;
  color?: string;
  trigger_kind: string;
  trigger_config: Record<string, unknown>;
  definition: {
    nodes: unknown[];
    edges: unknown[];
  };
}

const GCAL_SVG =
  '<path fill="currentColor" d="M18.316 5.684H24v12.632h-5.684zM5.684 24h12.632v-5.684H5.684zM18.316 5.684V0H1.895A1.894 1.894 0 0 0 0 1.895v16.421h5.684V5.684zm-7.207 6.25v-.065q.407-.216.687-.617c.28-.401.279-.595.279-.982q0-.568-.3-1.025a2.05 2.05 0 0 0-.832-.714a2.7 2.7 0 0 0-1.197-.257q-.9 0-1.481.467q-.579.467-.793 1.078l1.085.452q.13-.374.413-.633q.284-.258.767-.257q.495 0 .816.264a.86.86 0 0 1 .322.703q0 .495-.36.778t-.886.284h-.567v1.085h.633q.611 0 1.02.327q.407.327.407.843q0 .505-.387.832c-.387.327-.565.327-.924.327q-.527 0-.897-.311q-.372-.312-.521-.881l-1.096.452q.268.923.977 1.401q.707.479 1.538.477a2.84 2.84 0 0 0 1.293-.291q.574-.29.902-.794q.327-.505.327-1.149q0-.643-.344-1.105a2.07 2.07 0 0 0-.881-.689m2.093-1.931l.602.913L15 10.045v5.744h1.187V8.446h-.827zM22.105 0h-3.289v5.184H24V1.895A1.894 1.894 0 0 0 22.105 0m-3.289 23.5l4.684-4.684h-4.684zM0 22.105C0 23.152.848 24 1.895 24h3.289v-5.184H0z"/>';

const SLACK_SVG =
  '<path fill="currentColor" d="M5.042 15.165a2.53 2.53 0 0 1-2.52 2.523A2.53 2.53 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52a2.527 2.527 0 0 1 2.521 2.52v6.313A2.53 2.53 0 0 1 8.834 24a2.53 2.53 0 0 1-2.521-2.522zM8.834 5.042a2.53 2.53 0 0 1-2.521-2.52A2.53 2.53 0 0 1 8.834 0a2.53 2.53 0 0 1 2.521 2.522v2.52zm0 1.271a2.53 2.53 0 0 1 2.521 2.521a2.53 2.53 0 0 1-2.521 2.521H2.522A2.53 2.53 0 0 1 0 8.834a2.53 2.53 0 0 1 2.522-2.521zm10.122 2.521a2.53 2.53 0 0 1 2.522-2.521A2.53 2.53 0 0 1 24 8.834a2.53 2.53 0 0 1-2.522 2.521h-2.522zm-1.268 0a2.53 2.53 0 0 1-2.523 2.521a2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.53 2.53 0 0 1 2.523 2.522zm-2.523 10.122a2.53 2.53 0 0 1 2.523 2.522A2.53 2.53 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522zm0-1.268a2.527 2.527 0 0 1-2.52-2.523a2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.53 2.53 0 0 1-2.522 2.523z"/>';

const DISCORD_SVG =
  '<path fill="currentColor" d="M20.317 4.37a19.8 19.8 0 0 0-4.885-1.515a.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.3 18.3 0 0 0-5.487 0a13 13 0 0 0-.617-1.25a.08.08 0 0 0-.079-.037A19.7 19.7 0 0 0 3.677 4.37a.1.1 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.08.08 0 0 0 .031.057a19.9 19.9 0 0 0 5.993 3.03a.08.08 0 0 0 .084-.028a14 14 0 0 0 1.226-1.994a.076.076 0 0 0-.041-.106a13 13 0 0 1-1.872-.892a.077.077 0 0 1-.008-.128a10 10 0 0 0 .372-.292a.07.07 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.07.07 0 0 1 .078.01q.181.149.373.292a.077.077 0 0 1-.006.127a12.3 12.3 0 0 1-1.873.892a.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.08.08 0 0 0 .084.028a19.8 19.8 0 0 0 6.002-3.03a.08.08 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03M8.02 15.33c-1.182 0-2.157-1.085-2.157-2.419c0-1.333.956-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.956 2.418-2.157 2.418m7.975 0c-1.183 0-2.157-1.085-2.157-2.419c0-1.333.955-2.419 2.157-2.419c1.21 0 2.176 1.096 2.157 2.42c0 1.333-.946 2.418-2.157 2.418"/>';

const EMAIL_SVG =
  '<path fill="currentColor" d="M20 4H4c-1.103 0-2 .897-2 2v12c0 1.103.897 2 2 2h16c1.103 0 2-.897 2-2V6c0-1.103-.897-2-2-2zm0 2v.511l-8 6.223-8-6.222V6h16zM4 18V9.044l7.386 5.745a.994.994 0 0 0 1.228 0L20 9.044L20.002 18H4z"/>';

const NOTION_SVG =
  '<path fill="currentColor" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514c-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233l4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632"/>';

function withStartEnd(
  nodes: Array<{
    id: string;
    type: string;
    position: { x: number; y: number };
    data: Record<string, unknown>;
  }>,
  edges: Array<{
    id: string;
    source: string;
    target: string;
    [key: string]: unknown;
  }>,
): { nodes: unknown[]; edges: unknown[] } {
  const maxY = nodes.reduce((m, n) => Math.max(m, n.position.y), 0);
  const centerX = nodes.length
    ? Math.round(nodes.reduce((s, n) => s + n.position.x, 0) / nodes.length)
    : 300;
  const endNode = {
    id: 'end',
    type: 'end',
    position: { x: centerX, y: maxY + 160 },
    data: {
      kind: 'control.end',
      config: {},
      label: 'End',
      icon: 'bx-stop-circle',
    },
  };
  const lastId = nodes[nodes.length - 1]?.id ?? '';
  return {
    nodes: [...nodes, endNode],
    edges: [...edges, { id: 'e-last-end', source: lastId, target: 'end' }],
  };
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    id: 'slack-critical-task-alert',
    name: 'Slack alert on critical task',
    description:
      'Fires when a critical-priority task is created and posts an alert to Slack.',
    category: 'notifications',
    tags: ['slack', 'task', 'alert'],
    icon: 'bx-bell',
    svgIcon: SLACK_SVG,
    color: '#E01E5A',
    trigger_kind: 'app.task.created',
    trigger_config: { priority: 'critical' },
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.created', config: { priority: 'critical' } },
        },
        {
          id: 'slack-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.slack.send_message',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              channelId: '',
              text: '🚨 Critical task created: {{ trigger.task.summary }}\nStatus: {{ trigger.task.status }}\nSpace: {{ context.spaceId }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'slack-1' }],
    ),
  },
  {
    id: 'risk-threshold-slack',
    name: 'Risk threshold → Slack alert',
    description:
      'Fires when a process risk score crosses a threshold and notifies Slack.',
    category: 'notifications',
    tags: ['risk', 'slack', 'threshold', 'alert'],
    icon: 'bx-error-alt',
    svgIcon: SLACK_SVG,
    color: '#FF4757',
    trigger_kind: 'app.risk.threshold_crossed',
    trigger_config: { threshold: 75, direction: 'above' },
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: {
            kind: 'app.risk.threshold_crossed',
            config: { threshold: 75, direction: 'above' },
          },
        },
        {
          id: 'slack-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.slack.send_message',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              channelId: '',
              text: '⚠️ Risk score exceeded 75 for *{{ trigger.process.name }}*\nNew score: {{ trigger.newScore }}\nPrevious: {{ trigger.previousScore }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'slack-1' }],
    ),
  },
  {
    id: 'task-to-notion',
    name: 'New task → Notion page',
    description:
      'Creates a Notion database page whenever a task is created in this space.',
    category: 'integrations',
    tags: ['notion', 'task', 'sync'],
    icon: 'bx-note',
    svgIcon: NOTION_SVG,
    color: '#6E6BCD',
    trigger_kind: 'app.task.created',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.created', config: {} },
        },
        {
          id: 'notion-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.notion.create_page',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              databaseId: '',
              properties: {
                Name: {
                  title: [{ text: { content: '{{ trigger.task.summary }}' } }],
                },
                Status: { select: { name: '{{ trigger.task.status }}' } },
              },
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'notion-1' }],
    ),
  },
  {
    id: 'wiki-published-discord',
    name: 'Wiki page published → Discord',
    description: 'Posts a Discord message whenever a wiki page is published.',
    category: 'notifications',
    tags: ['wiki', 'discord', 'publish'],
    icon: 'bx-book-open',
    svgIcon: DISCORD_SVG,
    color: '#5865F2',
    trigger_kind: 'app.wiki.page_published',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.wiki.page_published', config: {} },
        },
        {
          id: 'discord-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.discord.post_webhook',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              content:
                '📖 New wiki page published: **{{ trigger.page.title }}**',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'discord-1' }],
    ),
  },
  {
    id: 'member-added-notification',
    name: 'New space member → In-app notification',
    description:
      'Sends an in-app welcome notification when a new member joins the space.',
    category: 'internal',
    tags: ['member', 'notification', 'welcome'],
    icon: 'bx-group',
    color: '#06B6D4',
    trigger_kind: 'app.space.member_added',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.space.member_added', config: {} },
        },
        {
          id: 'notify-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'app.notification.create',
            config: {
              userId: '{{ trigger.user.id }}',
              type: 'welcome',
              title: 'Welcome to the space!',
              body: 'You have been added to this workspace. Explore tasks, processes and more.',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'notify-1' }],
    ),
  },
  {
    id: 'task-assigned-slack',
    name: 'Task assigned → Slack DM',
    description:
      'Notifies the assignee on Slack whenever a task is assigned to them.',
    category: 'notifications',
    tags: ['task', 'slack', 'assigned'],
    icon: 'bx-user-check',
    svgIcon: SLACK_SVG,
    color: '#36C5F0',
    trigger_kind: 'app.task.assigned',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.assigned', config: {} },
        },
        {
          id: 'slack-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.slack.send_message',
            config: {
              connectionId: '',
              channelId: '',
              text: '📋 You have been assigned a task: *{{ trigger.task.summary }}*\nStatus: {{ trigger.task.status }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'slack-1' }],
    ),
  },
  {
    id: 'task-status-discord',
    name: 'Task status changed → Discord',
    description:
      'Posts a Discord message whenever a task moves to a new status.',
    category: 'notifications',
    tags: ['task', 'discord', 'status'],
    icon: 'bx-transfer',
    svgIcon: DISCORD_SVG,
    color: '#8B45FF',
    trigger_kind: 'app.task.status_changed',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.status_changed', config: {} },
        },
        {
          id: 'discord-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.discord.post_webhook',
            config: {
              connectionId: '',
              content:
                '🔄 Task status changed: **{{ trigger.task.summary }}**\n{{ trigger.previousStatus }} → {{ trigger.newStatus }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'discord-1' }],
    ),
  },
  {
    id: 'wiki-updated-slack',
    name: 'Wiki page updated → Slack',
    description: 'Posts a Slack message whenever a wiki page is edited.',
    category: 'notifications',
    tags: ['wiki', 'slack', 'content'],
    icon: 'bx-book-reader',
    svgIcon: SLACK_SVG,
    color: '#E91E63',
    trigger_kind: 'app.wiki.page_updated',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.wiki.page_updated', config: {} },
        },
        {
          id: 'slack-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.slack.send_message',
            config: {
              connectionId: '',
              channelId: '',
              text: '📝 Wiki page updated: *{{ trigger.page.title }}*\nView it in the app.',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'slack-1' }],
    ),
  },
  {
    id: 'weekly-report-email',
    name: 'Weekly report → Email',
    description:
      'Runs every Monday at 9 AM and sends a weekly summary email to the team.',
    category: 'scheduling',
    tags: ['schedule', 'email', 'weekly', 'report'],
    icon: 'bx-calendar-week',
    svgIcon: EMAIL_SVG,
    color: '#EA4335',
    trigger_kind: 'schedule.cron',
    trigger_config: { cron: '0 9 * * 1', timezone: 'UTC' },
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: {
            kind: 'schedule.cron',
            config: { cron: '0 9 * * 1', timezone: 'UTC' },
          },
        },
        {
          id: 'email-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.email.send',
            config: {
              to: [],
              subject: 'Weekly Report — {{ trigger.fired_at }}',
              bodyText:
                'Your weekly automation report for the space. Fired at: {{ trigger.fired_at }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'email-1' }],
    ),
  },
  {
    id: 'task-to-gcal',
    name: 'New task → Google Calendar event',
    description:
      'Creates a Google Calendar event with the task due date whenever a task is created.',
    category: 'integrations',
    tags: ['task', 'google-calendar', 'deadline'],
    icon: 'bx-calendar-event',
    svgIcon: GCAL_SVG,
    color: '#1A73E8',
    trigger_kind: 'app.task.created',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.created', config: {} },
        },
        {
          id: 'gcal-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.google_calendar.create_event',
            config: {
              connectionId: '',
              calendarId: 'primary',
              summary: '{{ trigger.task.summary }}',
              start: '{{ trigger.task.due_date }}',

              // No `end`: binding it to the same field as `start` makes a zero-length event, which
              // Google rejects with "The specified time range is empty". The action derives the end
              // from durationMinutes instead.
              durationMinutes: 60,
              timezone: 'UTC',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'gcal-1' }],
    ),
  },
  {
    id: 'task-to-webhook',
    name: 'New task → Outbound webhook',
    description:
      'Sends task details to any external HTTPS endpoint when a task is created.',
    category: 'integrations',
    tags: ['task', 'webhook', 'integration'],
    icon: 'bx-link-external',
    color: '#6F42C1',
    trigger_kind: 'app.task.created',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.created', config: {} },
        },
        {
          id: 'webhook-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.webhook.outbound',
            config: {
              url: '',
              method: 'POST',
              body: {
                task_id: '{{ trigger.task.id }}',
                summary: '{{ trigger.task.summary }}',
                status: '{{ trigger.task.status }}',
              },
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'webhook-1' }],
    ),
  },
  {
    id: 'task-comment-notify',
    name: 'Task comment → In-app notification',
    description:
      'Sends an in-app notification to the task assignee when a comment is added.',
    category: 'internal',
    tags: ['task', 'comment', 'notification'],
    icon: 'bx-comment-check',
    color: '#FF9800',
    trigger_kind: 'app.task.comment_added',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.comment_added', config: {} },
        },
        {
          id: 'notify-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'app.notification.create',
            config: {
              userId: '{{ trigger.task.assigned_to }}',
              type: 'task_comment',
              title: 'New comment on: {{ trigger.task.summary }}',
              body: '{{ trigger.comment.body }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'notify-1' }],
    ),
  },
  {
    id: 'user-invited-email',
    name: 'User invited → Welcome email',
    description:
      'Sends a personalised welcome email when a user is invited to the space.',
    category: 'internal',
    tags: ['user', 'email', 'welcome', 'onboarding'],
    icon: 'bx-mail-send',
    svgIcon: EMAIL_SVG,
    color: '#4CAF50',
    trigger_kind: 'app.user.invited',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.user.invited', config: {} },
        },
        {
          id: 'email-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.email.send',
            config: {
              to: ['{{ trigger.user.email }}'],
              subject: 'Welcome to the space!',
              bodyText:
                'Hi {{ trigger.user.name }}, you have been invited. Log in to get started.',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'email-1' }],
    ),
  },
  {
    id: 'plan-published-notify',
    name: 'Plan published → Team notification',
    description: 'Notifies all relevant team members when a plan is published.',
    category: 'internal',
    tags: ['plan', 'notification', 'team'],
    icon: 'bx-calendar-star',
    color: '#2196F3',
    trigger_kind: 'app.plan.published',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.plan.published', config: {} },
        },
        {
          id: 'notify-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'app.notification.create',
            config: {
              userId: '{{ context.actingUserId }}',
              type: 'plan_published',
              title: 'Plan published: {{ trigger.plan.name }}',
              referenceType: 'plan',
              referenceId: '{{ trigger.plan.id }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'notify-1' }],
    ),
  },
  {
    id: 'risk-email-alert',
    name: 'Risk threshold → Email alert',
    description:
      'Sends an email alert when a process risk score crosses the configured threshold.',
    category: 'notifications',
    tags: ['risk', 'email', 'alert', 'threshold'],
    icon: 'bx-error',
    svgIcon: EMAIL_SVG,
    color: '#FF5722',
    trigger_kind: 'app.risk.threshold_crossed',
    trigger_config: { threshold: 70, direction: 'above' },
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: {
            kind: 'app.risk.threshold_crossed',
            config: { threshold: 70, direction: 'above' },
          },
        },
        {
          id: 'email-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.email.send',
            config: {
              to: [],
              subject:
                '⚠️ Risk Alert: {{ trigger.process.name }} exceeded threshold',
              bodyText:
                'Process: {{ trigger.process.name }}\nNew score: {{ trigger.newScore }}\nPrevious: {{ trigger.previousScore }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'email-1' }],
    ),
  },

  // ── T1 ───────────────────────────────────────────────────────────────────
  {
    id: 'task-assigned-calendar',
    name: 'Task assigned → Google Calendar event',
    description:
      'Creates a Google Calendar event whenever a task is assigned, so the assignee never misses a deadline.',
    category: 'integrations',
    tags: ['task', 'google-calendar', 'assigned'],
    icon: 'bx-calendar-event',
    svgIcon: GCAL_SVG,
    color: '#1A73E8',
    trigger_kind: 'app.task.assigned',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.assigned', config: {} },
        },
        {
          id: 'gcal-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.google_calendar.create_event',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              summary: 'Task: {{ trigger.task.summary }}',
              start: '{{ trigger.task.due_date }}',
              durationMinutes: 60,
              description: 'Assigned by {{ trigger.task.reporter }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'gcal-1' }],
    ),
  },

  // ── T2 ───────────────────────────────────────────────────────────────────
  {
    id: 'task-comment-teams',
    name: 'Task comment → Teams message',
    description:
      'Posts a Microsoft Teams message whenever a comment is added to a task, keeping remote teams in the loop.',
    category: 'notifications',
    tags: ['task', 'comment', 'teams'],
    icon: 'bx-comment',
    color: '#6264A7',
    trigger_kind: 'app.task.comment_added',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.comment_added', config: {} },
        },
        {
          id: 'teams-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.teams.send_message',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              teamId: '',
              channelId: '',
              message:
                '💬 New comment on "{{ trigger.task.summary }}" by {{ trigger.comment.author }}: {{ trigger.comment.body }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'teams-1' }],
    ),
  },

  // ── T3 ───────────────────────────────────────────────────────────────────
  {
    id: 'process-updated-audit',
    name: 'Process updated → Audit log + Slack',
    description:
      'Writes an audit trail and broadcasts a Slack alert whenever a process is updated.',
    category: 'internal',
    tags: ['process', 'audit', 'slack'],
    icon: 'bx-git-commit',
    svgIcon: SLACK_SVG,
    color: '#7C3AED',
    trigger_kind: 'app.process.updated',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.process.updated', config: {} },
        },
        {
          id: 'audit-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'app.audit.log',
            config: {
              action: 'update',
              entityType: 'process',
              entityId: '{{ trigger.process.id }}',
            },
          },
        },
        {
          id: 'slack-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'integration.slack.send_message',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              channelId: '',
              text: '🔄 Process updated: *{{ trigger.process.name }}*\nUpdated by {{ trigger.updatedBy }}',
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'audit-1' },
        { id: 'e2', source: 'audit-1', target: 'slack-1' },
      ],
    ),
  },

  // ── T4 ───────────────────────────────────────────────────────────────────
  {
    id: 'plan-published-calendar',
    name: 'Plan published → Calendar milestone + notification',
    description:
      'Marks a plan go-live as a calendar event and sends an in-app notification to the space.',
    category: 'integrations',
    tags: ['plan', 'google-calendar', 'notification'],
    icon: 'bx-calendar-check',
    svgIcon: GCAL_SVG,
    color: '#0F9D58',
    trigger_kind: 'app.plan.published',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.plan.published', config: {} },
        },
        {
          id: 'gcal-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.google_calendar.create_event',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              summary: 'Plan published: {{ trigger.plan.name }}',
              start: '{{ trigger.plan.published_at }}',
              end: '{{ trigger.plan.published_at }}',
              description: 'Published in {{ trigger.plan.space_name }}',
            },
          },
        },
        {
          id: 'notify-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'app.notification.create',
            config: {
              userId: '{{ context.userId }}',
              type: 'info',
              title: 'Plan Published',
              body: 'Plan "{{ trigger.plan.name }}" has been published.',
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'gcal-1' },
        { id: 'e2', source: 'gcal-1', target: 'notify-1' },
      ],
    ),
  },

  // ── T5 ───────────────────────────────────────────────────────────────────
  {
    id: 'webhook-to-airtable',
    name: 'Webhook received → Airtable record',
    description:
      'Logs any external webhook payload as a new record in an Airtable base.',
    category: 'integrations',
    tags: ['webhook', 'airtable', 'data-sync'],
    icon: 'bx-grid-alt',
    color: '#F82B60',
    trigger_kind: 'webhook.received',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'webhook.received', config: {} },
        },
        {
          id: 'airtable-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.airtable.create_record',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              actionType: 'create_record',
              baseId: '',
              tableIdOrName: '',
              fieldMappings: [],
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'airtable-1' }],
    ),
  },

  // ── T6 ───────────────────────────────────────────────────────────────────
  {
    id: 'gdpr-record-audit',
    name: 'GDPR record added → Audit log + notification',
    description:
      'Writes a compliance audit trail and notifies the team whenever a new GDPR data record is added.',
    category: 'internal',
    tags: ['gdpr', 'compliance', 'audit'],
    icon: 'bx-shield',
    color: '#0369A1',
    trigger_kind: 'app.gdpr.record_added',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.gdpr.record_added', config: {} },
        },
        {
          id: 'audit-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'app.audit.log',
            config: {
              action: 'create',
              entityType: 'task',
              entityId: '{{ trigger.record.id }}',
            },
          },
        },
        {
          id: 'notify-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'app.notification.create',
            config: {
              userId: '{{ context.userId }}',
              type: 'warning',
              title: 'New GDPR Record',
              body: 'New GDPR record added for {{ trigger.record.subject }}.',
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'audit-1' },
        { id: 'e2', source: 'audit-1', target: 'notify-1' },
      ],
    ),
  },

  // ── T7 ───────────────────────────────────────────────────────────────────
  {
    id: 'asset-created-notify',
    name: 'Asset created → Notification + audit log',
    description:
      'Notifies the team and logs an audit entry whenever a new asset is created in the space.',
    category: 'notifications',
    tags: ['asset', 'notification', 'audit'],
    icon: 'bx-cube-alt',
    color: '#D97706',
    trigger_kind: 'app.asset.created',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.asset.created', config: {} },
        },
        {
          id: 'notify-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'app.notification.create',
            config: {
              userId: '{{ context.userId }}',
              type: 'info',
              title: 'New Asset',
              body: 'New asset created: {{ trigger.asset.name }} by {{ trigger.createdBy }}.',
            },
          },
        },
        {
          id: 'audit-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'app.audit.log',
            config: {
              action: 'create',
              entityType: 'task',
              entityId: '{{ trigger.asset.id }}',
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'notify-1' },
        { id: 'e2', source: 'notify-1', target: 'audit-1' },
      ],
    ),
  },

  // ── T8 ───────────────────────────────────────────────────────────────────
  {
    id: 'risk-email-teams',
    name: 'Risk threshold crossed → Email + Teams',
    description:
      'Sends a multi-channel alert via email and Microsoft Teams when a risk score crosses the threshold.',
    category: 'notifications',
    tags: ['risk', 'email', 'teams', 'alert'],
    icon: 'bx-error-alt',
    svgIcon: EMAIL_SVG,
    color: '#DC2626',
    trigger_kind: 'app.risk.threshold_crossed',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.risk.threshold_crossed', config: {} },
        },
        {
          id: 'email-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.email.send',
            config: {
              to: [],
              subject: '⚠️ Risk Alert: {{ trigger.risk.name }}',
              bodyText:
                'Risk "{{ trigger.risk.name }}" has crossed threshold.\nCurrent score: {{ trigger.risk.score }}\nPlease review immediately.',
            },
          },
        },
        {
          id: 'teams-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'integration.teams.send_message',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              teamId: '',
              channelId: '',
              message:
                '⚠️ Risk threshold crossed: *{{ trigger.risk.name }}*\nScore: {{ trigger.risk.score }}',
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'email-1' },
        { id: 'e2', source: 'email-1', target: 'teams-1' },
      ],
    ),
  },

  // ── T9 ───────────────────────────────────────────────────────────────────
  {
    id: 'task-to-github',
    name: 'Task created → GitHub issue',
    description:
      'Mirrors every new task as a GitHub issue so the dev team always has their backlog in sync.',
    category: 'integrations',
    tags: ['task', 'github', 'dev'],
    icon: 'bx-git-branch',
    color: '#24292F',
    trigger_kind: 'app.task.created',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.created', config: {} },
        },
        {
          id: 'github-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.github.create_issue',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              owner: '',
              repo: '',
              title: '{{ trigger.task.summary }}',
              body: '**Space:** {{ trigger.task.space_name }}\n\n{{ trigger.task.description }}',
              labels: ['imported'],
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'github-1' }],
    ),
  },

  // ── T10 ──────────────────────────────────────────────────────────────────
  {
    id: 'task-to-jira',
    name: 'Task created → Jira issue + Slack confirmation',
    description:
      'Creates a Jira issue for every new task and posts a Slack confirmation so the team is aware.',
    category: 'integrations',
    tags: ['task', 'jira', 'slack'],
    icon: 'bx-bug',
    svgIcon: SLACK_SVG,
    color: '#0052CC',
    trigger_kind: 'app.task.created',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.created', config: {} },
        },
        {
          id: 'jira-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.jira.create_issue',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              projectKey: '',
              summary: '{{ trigger.task.summary }}',
              description: '{{ trigger.task.description }}',
              issueType: 'Task',
            },
          },
        },
        {
          id: 'slack-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'integration.slack.send_message',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              channelId: '',
              text: '✅ Jira issue created for "{{ trigger.task.summary }}"',
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'jira-1' },
        { id: 'e2', source: 'jira-1', target: 'slack-1' },
      ],
    ),
  },

  // ── T11 ──────────────────────────────────────────────────────────────────
  {
    id: 'wiki-updated-email',
    name: 'Wiki page updated → Email + notification',
    description:
      'Emails stakeholders and sends an in-app notification whenever a wiki page is edited.',
    category: 'notifications',
    tags: ['wiki', 'email', 'notification'],
    icon: 'bx-edit-alt',
    svgIcon: EMAIL_SVG,
    color: '#7C3AED',
    trigger_kind: 'app.wiki.page_updated',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.wiki.page_updated', config: {} },
        },
        {
          id: 'email-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.email.send',
            config: {
              to: [],
              subject: '📄 Wiki updated: {{ trigger.page.title }}',
              bodyText:
                'The wiki page "{{ trigger.page.title }}" was updated by {{ trigger.updatedBy }}.\n\nPlease review the latest changes.',
            },
          },
        },
        {
          id: 'notify-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'app.notification.create',
            config: {
              userId: '{{ context.userId }}',
              type: 'info',
              title: 'Wiki Updated',
              body: 'Wiki page "{{ trigger.page.title }}" was updated.',
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'email-1' },
        { id: 'e2', source: 'email-1', target: 'notify-1' },
      ],
    ),
  },

  // ── T12 ──────────────────────────────────────────────────────────────────
  {
    id: 'task-to-trello',
    name: 'Task created → Trello card',
    description:
      'Syncs every new task to a Trello board as a card, keeping external boards up to date.',
    category: 'integrations',
    tags: ['task', 'trello', 'sync'],
    icon: 'bx-credit-card',
    color: '#0052CC',
    trigger_kind: 'app.task.created',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.task.created', config: {} },
        },
        {
          id: 'trello-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.trello.create_card',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              listId: '',
              name: '{{ trigger.task.summary }}',
              desc: '{{ trigger.task.description }}\n\nPriority: {{ trigger.task.priority }}',
            },
          },
        },
      ],
      [{ id: 'e1', source: 'trigger-1', target: 'trello-1' }],
    ),
  },

  // ── T13 ──────────────────────────────────────────────────────────────────
  {
    id: 'member-added-task',
    name: 'Space member added → Onboarding task + welcome email',
    description:
      'Auto-creates an onboarding task and sends a welcome email when a new member joins the space.',
    category: 'internal',
    tags: ['member', 'onboarding', 'task', 'email'],
    icon: 'bx-group',
    svgIcon: EMAIL_SVG,
    color: '#0F9D58',
    trigger_kind: 'app.space.member_added',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'app.space.member_added', config: {} },
        },
        {
          id: 'task-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'app.task.create',
            config: {
              summary: 'Onboarding: {{ trigger.member.name }}',
              description:
                'Complete onboarding for new member {{ trigger.member.name }} ({{ trigger.member.email }}).',
              priority: 'medium',
              assignedTo: '{{ trigger.member.id }}',
            },
          },
        },
        {
          id: 'email-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'integration.email.send',
            config: {
              to: ['{{ trigger.member.email }}'],
              subject: 'Welcome to the space!',
              bodyText:
                'Hi {{ trigger.member.name }},\n\nWelcome to {{ trigger.space.name }}! Your onboarding task has been created.',
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'task-1' },
        { id: 'e2', source: 'task-1', target: 'email-1' },
      ],
    ),
  },

  // ── T14 ──────────────────────────────────────────────────────────────────
  {
    id: 'daily-task-reminder',
    name: 'Daily task reminder → Slack + notification',
    description:
      'Sends a morning Slack message and in-app nudge every weekday at 8 AM UTC to remind the team to review open tasks.',
    category: 'scheduling',
    tags: ['cron', 'slack', 'reminder', 'daily'],
    icon: 'bx-alarm',
    svgIcon: SLACK_SVG,
    color: '#F59E0B',
    trigger_kind: 'schedule.cron',
    trigger_config: { cron: '0 8 * * 1-5', timezone: 'UTC' },
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: {
            kind: 'schedule.cron',
            config: { cron: '0 8 * * 1-5', timezone: 'UTC' },
          },
        },
        {
          id: 'slack-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'integration.slack.send_message',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              channelId: '',
              text: '🌅 Good morning! Review your open tasks and update statuses for today.',
            },
          },
        },
        {
          id: 'notify-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'app.notification.create',
            config: {
              userId: '{{ context.userId }}',
              type: 'info',
              title: 'Daily Reminder',
              body: 'Review your open tasks today.',
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'slack-1' },
        { id: 'e2', source: 'slack-1', target: 'notify-1' },
      ],
    ),
  },

  // ── T15 ──────────────────────────────────────────────────────────────────
  {
    id: 'webhook-to-task-github',
    name: 'Webhook received → Create task + GitHub issue',
    description:
      'Converts any incoming webhook payload into a tracked task and a GitHub issue for full traceability.',
    category: 'integrations',
    tags: ['webhook', 'task', 'github'],
    icon: 'bx-link-external',
    color: '#24292F',
    trigger_kind: 'webhook.received',
    trigger_config: {},
    definition: withStartEnd(
      [
        {
          id: 'trigger-1',
          type: 'trigger',
          position: { x: 300, y: 50 },
          data: { kind: 'webhook.received', config: {} },
        },
        {
          id: 'task-1',
          type: 'action',
          position: { x: 300, y: 200 },
          data: {
            kind: 'app.task.create',
            config: {
              summary: '{{ trigger.payload.title }}',
              description:
                '{{ trigger.payload.description }}\n\nSource: {{ trigger.payload.source }}',
              priority: 'medium',
            },
          },
        },
        {
          id: 'github-1',
          type: 'action',
          position: { x: 300, y: 370 },
          data: {
            kind: 'integration.github.create_issue',
            config: {
              connectionId: '__REPLACE_WITH_CONNECTION_ID__',
              owner: '',
              repo: '',
              title: '{{ trigger.payload.title }}',
              body: '{{ trigger.payload.description }}',
              labels: ['external-request'],
            },
          },
        },
      ],
      [
        { id: 'e1', source: 'trigger-1', target: 'task-1' },
        { id: 'e2', source: 'task-1', target: 'github-1' },
      ],
    ),
  },
];
