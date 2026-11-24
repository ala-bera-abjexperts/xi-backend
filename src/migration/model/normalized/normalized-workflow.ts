/**
 * @fileoverview Source-agnostic workflow. On Jira Server the transition graph comes from the
 * projectconfig endpoint (`jira-workflow-graph.util.ts`); `transitions` is null only when that
 * endpoint is unreadable, in which case the builder falls back to the all-to-all graph. Cloud
 * (Phase 8) fills `transitions` from its public REST.
 */

export interface NormalizedWorkflowTransition {
  /** Status sourceId the transition starts from; null = global ("from any"). */
  fromStatusSourceId: string | null;
  toStatusSourceId: string;
  name: string;
}

export interface NormalizedWorkflow {
  /** Workflow name doubles as the stable id on Server (names are unique per instance). */
  sourceId: string;
  name: string;
  description?: string;
  /** Status sourceIds that appear in this workflow. */
  statusSourceIds: string[];
  /** Transition graph — null when the source cannot report it (Jira Server public REST). */
  transitions: NormalizedWorkflowTransition[] | null;
  /** Issue type sourceIds bound to this workflow via the project's workflow scheme; '*' = default. */
  issueTypeSourceIds: string[];
  isDefault: boolean;
  /**
   * Status sourceId new issues start on, inferred from the graph (outgoing edges, none incoming).
   * The projectconfig payload has no explicit create transition, so inference is the closest
   * faithful answer; absent when the graph is unreadable or fully cyclic.
   */
  initialStatusSourceId?: string;
  /** Transition name → Jira screen name. Screens are NOTED for the report, never bound. */
  screensByTransition?: Record<string, string>;
  /** Explicit source-read fallbacks that must appear in the migration audit log. */
  migrationWarnings?: string[];
}
