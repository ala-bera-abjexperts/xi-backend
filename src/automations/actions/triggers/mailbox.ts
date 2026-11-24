import type { CatalogTrigger } from '../../automation-trigger-catalog.service';

// Category is 'schedule' rather than a new literal: this is interval-driven
// polling, and widening CatalogTrigger.category would ripple into every
// consumer of that union for no behavioural gain.
export const mailboxEmailReceivedTrigger: CatalogTrigger = {
  kind: 'mailbox.email_received',
  category: 'schedule',
  type: 'trigger',
  requiresConnection: 'ms_graph_mailbox',
  label: { en: 'Email received', de: 'E-Mail empfangen' },
  description: {
    en: 'Fires once per new email in a connected Microsoft 365 mailbox',
    de: 'Wird für jede neue E-Mail in einem verbundenen Microsoft-365-Postfach ausgelöst',
  },
  icon: 'bx-envelope',
  configSchema: {
    type: 'object',
    properties: {
      connectionId: {
        type: 'string',
        title: 'Mailbox connection',
        description: 'The connected Microsoft 365 mailbox to read from',
      },
      folder: {
        type: 'string',
        title: 'Folder',
        default: 'inbox',
        description: 'Mail folder to watch. Defaults to the inbox.',
      },
      pollIntervalSeconds: {
        type: 'number',
        title: 'Check every (seconds)',
        default: 60,
        // Mirrors MIN_POLL_INTERVAL_SECONDS. Advertised only — the publish-time
        // Math.max clamp is what actually protects the poller.
        minimum: 60,
        description:
          'How often to check for new mail. Minimum 60s — tighter intervals get throttled by Microsoft.',
      },
      taskType: {
        type: 'string',
        title: 'Task type',
        description:
          "Task type for created tickets. Leave blank to use the space's default.",
      },
      status: {
        type: 'string',
        title: 'Initial status',
        description: "Leave blank to use the task type's default status.",
      },
      priority: {
        type: 'string',
        title: 'Priority',
        description: "Leave blank to use the task type's default priority.",
      },
      assignedTo: {
        type: 'string',
        title: 'Assign to',
        description: 'Optional default assignee for every created ticket.',
      },
      blockedSenders: {
        type: 'string',
        title: 'Blocked senders',
        description:
          "Comma-separated addresses or @domains to ignore. The mailbox's own address is always ignored.",
      },
      allowedSenders: {
        type: 'string',
        title: 'Allowed senders',
        description:
          'Optional allow-list. When set, only these addresses or @domains create tickets.',
      },
      maxBodyChars: {
        type: 'number',
        title: 'Max body length',
        default: 100000,
        description:
          'Longer bodies are truncated with a visible marker rather than rejected.',
      },
    },
    required: ['connectionId'],
  },
  outputSchema: {
    type: 'object',
    properties: {
      messageId: { type: 'string', title: 'Message-ID' },
      ledgerId: {
        type: 'string',
        title: 'Ingestion record id (used for duplicate protection)',
      },
      from: { type: 'string', title: 'Sender address' },
      fromName: { type: 'string', title: 'Sender display name' },
      subject: { type: 'string', title: 'Subject' },
      bodyHtml: { type: 'string', title: 'Body (HTML)' },
      receivedAt: { type: 'string', title: 'Received at (ISO datetime)' },
      hasAttachments: { type: 'boolean', title: 'Has attachments' },
      attachments: {
        type: 'array',
        title: 'Attachment metadata (name, type, size — files not imported)',
      },
    },
  },
};

export const mailboxTriggers: CatalogTrigger[] = [mailboxEmailReceivedTrigger];
