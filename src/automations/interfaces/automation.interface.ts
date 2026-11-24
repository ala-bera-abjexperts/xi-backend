export type AutomationStatus = 'draft' | 'published' | 'paused' | 'archived';
export type RunStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type StepStatus =
  | 'pending'
  | 'running'
  | 'sleeping'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'paused'
  | 'cancelled';
export type ConnectionProvider =
  | 'slack'
  | 'notion'
  | 'google_calendar'
  | 'google_sheets'
  | 'google_drive'
  | 'email'
  | 'webhook_outbound'
  | 'github'
  | 'jira'
  | 'linear'
  | 'teams'
  | 'outlook'
  | 'clickup'
  | 'asana'
  | 'trello'
  | 'discord'
  | 'airtable'
  | 'hubspot'
  | 'salesforce'
  | 'twilio'
  // Inbound mailbox reader (Mail.Read). Separate from 'outlook', which is
  // send-only (Mail.Send) — existing tokens cannot read mail.
  | 'ms_graph_mailbox';

export interface IAutomation {
  id: string;
  organization_id: string;
  space_id: string;
  name: string;
  description: string | null;
  icon: string | null;
  status: AutomationStatus;
  current_version_id: string | null;
  published_version_id: string | null;
  next_run_at: string | null;
  webhook_token: string | null;
  webhook_secret_encrypted: string | null;
  webhook_secret_iv: string | null;
  webhook_secret_tag: string | null;
  last_run_at: string | null;
  last_run_status: 'succeeded' | 'failed' | 'cancelled' | null;
  is_archived: boolean;
  max_concurrent_runs?: number | null;
  // Populated by listForSpace() from the effective version; absent on single-get paths.
  trigger_kind?: string | null;
  trigger_node_count?: number;
  action_count?: number;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface IAutomationNode {
  id: string;
  kind?: string;
  type?: string;
  label?: string;
  position: { x: number; y: number };
  config?: Record<string, unknown>;
  data?: {
    kind?: string;
    label?: string;
    icon?: string;
    config?: Record<string, unknown>;
  };
}

export interface IAutomationEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  sourceHandle?: string;
  targetHandle?: string;
}

export interface IAutomationDefinition {
  nodes: IAutomationNode[];
  edges: IAutomationEdge[];
  variables?: Record<string, unknown>;
}

export interface IAutomationVersion {
  id: string;
  automation_id: string;
  space_id: string;
  version_number: number;
  definition: IAutomationDefinition;
  trigger_kind: string;
  trigger_config: Record<string, unknown>;
  is_draft: boolean;
  is_published: boolean;
  published_at: string | null;
  created_at: string;
  created_by: string | null;
}

export type IAutomationVersionSummary = Omit<
  IAutomationVersion,
  'definition' | 'trigger_config'
>;

export interface IAutomationRun {
  id: string;
  automation_id: string;
  automation_version_id: string;
  space_id: string;
  organization_id: string;
  trigger_kind: string;
  trigger_event_id: string | null;
  trigger_payload: Record<string, unknown> | null;
  status: RunStatus;
  correlation_id: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
  error_step_id: string | null;
  created_at: string;
}

export interface IAutomationRunStep {
  id: string;
  run_id: string;
  space_id: string;
  node_id: string;
  node_kind: string;
  step_index: number;
  status: StepStatus;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error_message: string | null;
  retry_count: number;
  wakeup_at: string | null;
  lease_until: string | null;
  worker_id: string | null;
  next_step_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface IAutomationConnection {
  id: string;
  organization_id: string;
  space_id: string;
  provider: ConnectionProvider;
  display_name: string;
  external_account_id: string | null;
  encrypted_secret: string;
  encryption_iv: string;
  encryption_tag: string;
  metadata: Record<string, unknown>;
  is_revoked: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface IAutomationConnectionResponse {
  id: string;
  organization_id: string;
  space_id: string;
  provider: ConnectionProvider;
  display_name: string;
  external_account_id: string | null;
  masked_secret: string;
  metadata: Record<string, unknown>;
  // Display-only previews of the public Azure app-registration ids, so the edit form can show
  // which app is configured without ever round-tripping a real credential.
  masked_metadata: Record<string, string>;
  is_revoked: boolean;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface IAutomationSchedule {
  id: string;
  automation_id: string;
  space_id: string;
  cron_expression: string;
  timezone: string;
  next_run_at: string;
  last_run_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface IAutomationMailboxPoller {
  id: string;
  automation_id: string;
  space_id: string;
  organization_id: string;
  connection_id: string;
  folder: string;
  // Graph deltaLink; cleared and re-seeded when Graph answers 410 Gone.
  delta_cursor: string | null;
  // Nothing received before this is ingested — stops a mailbox with history
  // from backfilling thousands of tickets on first publish.
  watermark_at: string;
  poll_interval_seconds: number;
  is_active: boolean;
  last_polled_at: string | null;
  last_error: string | null;
  lease_until: string | null;
  worker_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IAutomationEventSubscription {
  id?: string;
  automation_id: string;
  space_id: string;
  organization_id: string;
  event_kind: string;
  filters: Record<string, unknown>;
  is_active: boolean;
  created_at?: string;
}
