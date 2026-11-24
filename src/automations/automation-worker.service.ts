// Automation worker — lease pending steps, execute action handlers, mark results, advance DAG.

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ZodError } from 'zod';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import {
  decryptApiKey,
  encryptApiKey,
  unpackStoredSecret,
} from '../lib/crypto/encryption';
import { AutomationQueueService, WORKER_BUDGET_MS } from './utils/queue';
import {
  advanceDag,
  isControlNode,
  controlNodeOutcome,
  type DagDefinition,
  type DagNode,
} from './utils/dag-engine';
import type { EvalContext } from './utils/expression';
import {
  answersJson,
  answersTable,
  answersText,
  type MediaResolver,
  type SubmissionLike,
} from './utils/submission-answers';
import {
  collectPlaceholderValues,
  expandTaskIdToReadable,
  substitute,
  type ObjectFormatter,
  type ValueFormatter,
} from './utils/template';
import { ActionRegistryService } from './actions/action-registry.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import type {
  ExecutionContext,
  ConnectionProvider,
  SubmissionMediaItem,
} from './actions/types';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Config fields whose value a person reads, keyed by action kind.
 *
 * Only these get `{{ …task.id }}` expanded to "KEY — Summary". Everything else — webhook bodies,
 * `entityId`, `taskId`, header maps — keeps the raw UUID, because those are parsed by an API rather
 * than read by a human.
 * Ids of users, tasks, spaces and other named records resolved in these fields are also shown as names.
 */
const HUMAN_TEXT_FIELDS: Record<string, ReadonlySet<string>> = {
  'integration.teams.send_message': new Set(['message', 'title']),
  'integration.slack.send_message': new Set(['text']),
  'integration.discord.post_webhook': new Set(['content', 'username']),
  'integration.email.send': new Set(['subject', 'body']),
  'integration.outlook.send_email': new Set(['subject', 'body']),
  'app.notification.create': new Set(['title', 'message', 'body']),
  'app.task.add_comment': new Set(['body']),
  'app.asset_object.create': new Set(['name', 'description']),
  'app.asset_object.update': new Set(['name', 'description']),
  'app.asset_object.add_comment': new Set(['body']),
  'app.asset_object.add_attachment': new Set(['fileName']),
  'app.asset_object.send_details_email': new Set(['subject']),

  // Text a person reads, on the remaining node kinds. What is deliberately NOT here matters just as
  // much: date fields (`dueDate` → 22007 on a timestamptz), id fields (`taskId`, `parentTaskId`,
  // `assignedTo`, `userId`, `spaceId`, `connectionId`, `schemaId`, `assetId` → 22P02 on a uuid),
  // `fileUrl`, `fileNamePattern`, Airtable's `filterByFormula`, and the outbound webhook body —
  // that one is a machine payload an external API parses, so it stays exactly as written.
  'app.task.create': new Set(['summary', 'description']),
  'app.task.update': new Set(['summary', 'description']),
  'app.wiki.create_page': new Set(['title', 'content']),
  'app.wiki.update_page': new Set(['title', 'content']),
  'app.risk.update': new Set(['notes']),
  'app.plan.create': new Set(['name', 'description']),
  'app.document.export_by_template': new Set([
    'subject',
    'message',
    'wikiTitle',
  ]),
  'app.space.create_from_template': new Set(['spaceName', 'description']),
  'integration.github.create_issue': new Set(['title', 'body']),
  'integration.jira.create_issue': new Set(['summary', 'description']),
  'integration.linear.create_issue': new Set(['title', 'description']),
  'integration.google_calendar.create_event': new Set([
    'summary',
    'description',
  ]),
  'integration.clickup.create_task': new Set(['name', 'description']),
  'integration.asana.create_task': new Set(['name', 'notes']),
  'integration.trello.create_card': new Set(['name', 'desc']),
  'integration.twilio.send_sms': new Set(['body']),
  'integration.hubspot.fetch_or_create_contact': new Set(['notes']),
  'integration.salesforce.create_lead': new Set(['description']),
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Task custom field types that hold free text a person reads; every other type keeps exact values. */
const TEXT_CUSTOM_FIELD_TYPES = new Set(['string', 'editor']);

const TASK_CUSTOM_FIELD_KINDS = new Set(['app.task.create', 'app.task.update']);

/** A value that is exactly one `{{ }}` placeholder, so it may be a real id. */
const BARE_PLACEHOLDER_RE = /^\s*\{\{[^{}]*\}\}\s*$/;

/**
 * What a person sees where a `{{ }}` had nothing to show.
 *
 * Only fields a person reads use it — a Slack message or a task summary reading
 * "{{ trigger.task.custom_field_values.hardware }}" is meaningless to the recipient.
 */
const EMPTY_TEXT_MARKER = '-';

/**
 * A config key that is a string but is NOT read by a person, so an empty `{{ }}` must stay a literal
 * placeholder there rather than becoming "-".
 *
 * This is the whole safety boundary of the empty marker. Every one of these ends up in a typed column
 * or a machine payload: "-" in a uuid is a Postgres 22P02, in a timestamptz a 22007, in a status enum
 * a 23514 — and `hasUnresolvedPlaceholder` (11 call sites) goes blind, so `app.task.update` would
 * WRITE "-" into a custom field instead of skipping it and Find Asset would hunt for an asset
 * literally named "-".
 */
const NON_HUMAN_KEY_RE =
  /(^|[a-z])(id|ids|key|keys)$|date|time|^at$|at$|secret|token|password|url|webhook|cron|expression|formula|pattern|filterrules|connection|^(status|priority|type|tasktype|mode|combinator|operator|scopemode|destination|namematch)$/i;

/**
 * Actions whose string config is a payload for another system, so NOTHING in them is auto-derived.
 *
 * `integration.webhook.outbound.body` is the case that forces this: it is a body an external API
 * parses, and the key name alone reads like ordinary prose. A kind listed here can still opt individual
 * keys in through {@link HUMAN_TEXT_FIELDS}, which stays authoritative.
 */
const MACHINE_PAYLOAD_KINDS = new Set(['integration.webhook.outbound']);

/** Zod wrappers that sit around the real type — unwrapped before asking "is this a string?". */
const ZOD_WRAPPERS = new Set([
  'ZodOptional',
  'ZodNullable',
  'ZodDefault',
  'ZodEffects',
  'ZodBranded',
  'ZodCatch',
  'ZodReadonly',
]);

const PLACEHOLDER_RE = /\{\{\s*[^}]+?\s*\}\}/g;

/**
 * Org-scoped tables whose ids read as a label in human text; listed columns join with " — ".
 * A table without organization_id is scoped through its parent's inner-joined organization_id.
 */
const READABLE_ID_TABLES: ReadonlyArray<{
  table: string;
  columns: string[];
  parent?: { embed: string; orgColumn: string };
}> = [
  { table: 'tasks', columns: ['key', 'summary'] },
  { table: 'spaces', columns: ['name'] },
  { table: 'asset_objects', columns: ['name'] },
  { table: 'business_processes', columns: ['key', 'title'] },
  { table: 'wiki_pages', columns: ['title'] },
  { table: 'asset_items', columns: ['title'] },
  { table: 'gdpr_spreadsheets', columns: ['title'] },
  { table: 'task_attachments', columns: ['file_name'] },
  { table: 'asset_object_attachments', columns: ['file_name'] },
  {
    table: 'plan_baselines',
    columns: ['name'],
    parent: {
      embed: 'plans!plan_baselines_plan_id_fkey!inner(organization_id)',
      orgColumn: 'plans.organization_id',
    },
  },
  {
    table: 'workflow_transitions',
    columns: ['name'],
    parent: {
      embed:
        'workflows!workflow_transitions_workflow_id_fkey!inner(organization_id)',
      orgColumn: 'workflows.organization_id',
    },
  },
  ...[
    'asset_object_types',
    'asset_schemas',
    'task_statuses',
    'plans',
    'form_builder',
    'boards',
    'sprints',
    'dashboards',
    'portfolios',
    'relation_types',
    'custom_fields',
    'automations',
    'workflows',
  ].map((table) => ({ table, columns: ['name'] })),
];

function joinColumns(
  row: Record<string, unknown>,
  columns: string[],
  separator: string,
): string {
  return columns
    .map((column) => row[column])
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .join(separator);
}

function placeholderUuids(template: string, ctx: EvalContext): string[] {
  return collectPlaceholderValues(template, ctx)
    .flatMap((value): unknown[] => (Array.isArray(value) ? value : [value]))
    .filter(
      (item): item is string => typeof item === 'string' && UUID_RE.test(item),
    );
}

/** Private bucket; links are signed, so a submitted photo is not permanently world-readable. */
const AUTOMATION_MEDIA_BUCKET = 'attachments';

/** Seven days — long enough for a message to stay useful, short enough to expire. */
const AUTOMATION_MEDIA_TTL_SECONDS = 60 * 60 * 24 * 7;

interface RunRow {
  id: string;
  automation_id: string;
  automation_version_id: string;
  space_id: string;
  organization_id: string;
  status: string;
  trigger_kind: string;
  trigger_payload: Record<string, unknown>;
}

export interface WorkerStats {
  workerId: string;
  durationMs: number;
  dispatched: number;
  succeeded: number;
  failed: number;
  slept: number;
}

@Injectable()
export class AutomationWorkerService {
  private readonly logger = new Logger(AutomationWorkerService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly queue: AutomationQueueService,
    private readonly actionRegistry: ActionRegistryService,
    private readonly auditLogs: AuditLogsService,
    @Optional()
    private readonly broadcastService?: NotificationsBroadcastService,
  ) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  async runWorkerLoop(
    workerId: string,
    shouldStop?: () => boolean,
  ): Promise<WorkerStats> {
    const startedAt = Date.now();
    const stats = { dispatched: 0, succeeded: 0, failed: 0, slept: 0 };

    // Backstop: finalize leftover steps of runs that already ended (failed/cancelled/succeeded).
    // The immediate failure sweep handles the common case; this catches stale runs from before that
    // logic + rare fan-out race stragglers. A stuck 'running' step otherwise makes leaseSteps treat the
    // run as "busy", so its pending siblings are never drained and stay stuck forever. Only touches
    // steps whose run is already terminal — cannot disturb active runs. Runs once per worker tick.
    try {
      const { data: stale } = await this.db
        .from('automation_run_steps')
        .select('id, automation_runs!inner(status)')
        .in('status', ['pending', 'running', 'sleeping', 'paused'])
        .in('automation_runs.status', ['failed', 'cancelled', 'succeeded'])
        .limit(500);

      const staleIds = ((stale ?? []) as Array<{ id: string }>).map(
        (s) => s.id,
      );

      if (staleIds.length > 0) {
        await this.db
          .from('automation_run_steps')
          .update({
            status: 'cancelled',
            error_message: 'Skipped — run ended',
            lease_until: null,
            worker_id: null,
          })
          .in('id', staleIds)
          .in('status', ['pending', 'running', 'sleeping', 'paused']);
      }
    } catch (err: unknown) {
      this.logger.error(
        `[worker] reconcile ended-run steps failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // shouldStop: a shutdown drain finishes the batch in hand, then leases no more.
    while (Date.now() - startedAt < WORKER_BUDGET_MS && !shouldStop?.()) {
      const steps = await this.queue.leaseSteps(workerId, 10);
      if (steps.length === 0) break;

      for (const step of steps) {
        const stepStartedAt = Date.now();
        let maxRetries = 3;
        let retryDelayMs: number | undefined;
        let run: RunRow | null = null;

        try {
          const { data: runData, error: runErr } = await this.db
            .from('automation_runs')
            .select(
              'id, automation_id, automation_version_id, space_id, organization_id, status, trigger_kind, trigger_payload',
            )
            .eq('id', step.run_id)
            .single();

          run = runData as RunRow | null;
          if (runErr || !run) throw new Error(`Run ${step.run_id} not found`);

          const r = run as unknown as Record<string, unknown>;
          if (
            !r['id'] ||
            !r['automation_id'] ||
            !r['automation_version_id'] ||
            !r['space_id'] ||
            !r['organization_id']
          ) {
            throw new Error(
              `Run ${step.run_id} has incomplete data — possible schema drift`,
            );
          }

          // If the run already reached a terminal state (failed by another step/branch, or
          // cancelled by the user), do NOT execute this step — cancel it and move on. This
          // stops downstream / sibling nodes once the run itself has stopped.
          if (
            r['status'] === 'failed' ||
            r['status'] === 'cancelled' ||
            r['status'] === 'succeeded'
          ) {
            await this.db
              .from('automation_run_steps')
              .update({
                status: 'cancelled',
                lease_until: null,
                worker_id: null,
              })
              .eq('id', step.id);
            stats.dispatched++;
            continue;
          }

          const { data: version, error: versionErr } = await this.db
            .from('automation_versions')
            .select('definition')
            .eq('id', run.automation_version_id)
            .single();

          if (versionErr || !version)
            throw new Error(`Version not found for run ${step.run_id}`);

          const definition = (version as { definition: DagDefinition })
            .definition;
          const node = definition.nodes.find(
            (n: DagNode) => n.id === step.node_id,
          );

          if (!node) {
            await this.queue.markStepFailed(
              step.id,
              `Node ${step.node_id} not found in definition`,
              step.retry_count,
              0,
            );
            stats.failed++;
            continue;
          }

          if (!node.data?.kind) {
            await this.queue.markStepFailed(
              step.id,
              `Node ${step.node_id} has no data.kind`,
              step.retry_count,
              0,
            );
            stats.failed++;
            continue;
          }

          const retryPolicy = node.data.retryPolicy as
            | { maxRetries?: number; retryDelayMs?: number }
            | undefined;
          maxRetries = retryPolicy?.maxRetries ?? 3;
          retryDelayMs = retryPolicy?.retryDelayMs;

          const evalCtx = await this.buildEvalContext(run, step, definition);
          const answerMedia = await this.collectAnswerMedia(run, node);

          const templateCtx: EvalContext = {
            ...evalCtx,
            customFields:
              (node.data as { customFields?: Record<string, unknown> })
                .customFields ?? {},
          };
          const humanTextFields = this.humanTextKeysFor(
            String(node.data.kind),
            node.data.config ?? {},
          );
          const textCustomFieldKeys = await this.findTextCustomFieldKeys(
            run,
            String(node.data.kind),
            node.data.config ?? {},
            templateCtx,
          );

          const resolvedConfig = this.resolveConfigTemplates(
            node.data.config ?? {},
            templateCtx,
            humanTextFields,
            this.buildAnswerFormatter(run, definition, answerMedia.urls),
            await this.buildReadableIdFormatter(
              run,
              node.data.config ?? {},
              templateCtx,
              humanTextFields,
              textCustomFieldKeys,
            ),
            textCustomFieldKeys,
            String(node.data.kind),
          );

          if (isControlNode(node.data.kind)) {
            const nodeWithResolvedConfig = {
              ...node,
              data: { ...node.data, config: resolvedConfig },
            };
            const outcome = controlNodeOutcome(
              nodeWithResolvedConfig,
              definition,
              step.input,
              evalCtx,
            );

            // The run may have ended (a sibling step failed) while config was resolving — don't sleep,
            // mark succeeded, or enqueue fresh steps onto an already-terminal run.
            if (await this.isRunTerminal(run.id)) {
              await this.cancelStepForEndedRun(step.id);
              continue;
            }

            if (outcome.kind === 'sleep') {
              await this.queue.markStepSleeping(step.id, outcome.wakeupAt);
              stats.slept++;
            } else if (outcome.kind === 'filter_out') {
              await this.queue.markStepSucceeded(
                step.id,
                { filtered: true },
                Date.now() - stepStartedAt,
              );
              await this.checkAndMarkRunComplete(run.id, run.organization_id);
              stats.succeeded++;
            } else {
              await this.queue.markStepSucceeded(
                step.id,
                outcome.output ?? {},
                Date.now() - stepStartedAt,
              );
              await this.enqueueNextSteps(
                run,
                definition,
                step,
                outcome.nextNodes,
              );
              await this.checkAndMarkRunComplete(run.id, run.organization_id);
              stats.succeeded++;
            }
          } else {
            // Pause before execution if node has a debug breakpoint set
            if (node.data.pauseBeforeExecution) {
              await this.db
                .from('automation_run_steps')
                .update({
                  status: 'paused',
                  lease_until: null,
                  worker_id: null,
                })
                .eq('id', step.id);
              stats.dispatched++;
              continue;
            }

            const ctx = await this.buildExecutionContext({
              run: run,
              step,
              evalCtx,
              definition,
              submissionMedia: answerMedia.items,
            });
            const output = await this.dispatchAction(
              node.data.kind,
              resolvedConfig,
              step.input,
              ctx,
            );

            // The run may have ended (a sibling step failed) while this action was in flight —
            // don't persist success or advance the DAG onto an already-terminal run.
            if (await this.isRunTerminal(run.id)) {
              await this.cancelStepForEndedRun(step.id);
              continue;
            }

            await this.queue.markStepSucceeded(
              step.id,
              output,
              Date.now() - stepStartedAt,
            );
            const nextNodes = advanceDag(definition, step.node_id);
            await this.enqueueNextSteps(run, definition, step, nextNodes);
            await this.checkAndMarkRunComplete(run.id, run.organization_id);
            stats.succeeded++;
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `[worker] step failed: ${JSON.stringify({ stepId: step.id, error: message })}`,
          );

          // If the run already ended while this step was executing, don't retry it or re-mark the
          // run failed — just cancel this step so it doesn't keep retrying on a terminal run.
          if (await this.isRunTerminal(step.run_id)) {
            await this.cancelStepForEndedRun(step.id);
            continue;
          }

          // Permanent failures will never resolve by retrying — skip retries and fail fast:
          //  - HTTP 4xx (except 429 rate-limit), detected from a "(4xx)" in the error message.
          //  - Config-validation (ZodError): re-running identical invalid config can't succeed,
          //    and its message has no "(status)" so it would otherwise be retried 3× and appear
          //    stuck "Running" for a node that can never proceed.
          const statusMatch = message.match(/\((\d{3})\)/);
          const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;
          const isPermanent =
            err instanceof ZodError ||
            // A missing/revoked connection can't be fixed by retrying — fail fast so the node
            // doesn't retry 3× and appear stuck "Running" (same guarantee ZodError had before
            // blank connectionIds stopped throwing here).
            /No active .*connection found|connection used by this automation has been revoked/i.test(
              message,
            ) ||
            (httpStatus !== null &&
              httpStatus >= 400 &&
              httpStatus < 500 &&
              httpStatus !== 429);
          const effectiveMaxRetries = isPermanent
            ? step.retry_count + 1
            : maxRetries;

          await this.queue.markStepFailed(
            step.id,
            message,
            step.retry_count,
            effectiveMaxRetries,
            retryDelayMs,
          );

          if (step.retry_count + 1 >= effectiveMaxRetries) {
            await this.db
              .from('automation_runs')
              .update({
                status: 'failed',
                error_message: message.slice(0, 1000),
                error_step_id: step.node_id,
                finished_at: new Date().toISOString(),
              })
              .eq('id', step.run_id);

            // Stop the whole run: cancel every remaining non-terminal step so no downstream
            // node or sibling branch executes after this failure. Includes 'running' so a leased
            // sibling step (executing on another worker at this instant) is marked cancelled
            // promptly; that worker's own terminal-run guard then keeps it cancelled on finish.
            // `.neq('id', step.id)` protects the just-failed current step, which is already 'failed'.
            await this.db
              .from('automation_run_steps')
              .update({
                status: 'cancelled',
                error_message: 'Skipped — run failed',
                lease_until: null,
                worker_id: null,
              })
              .eq('run_id', step.run_id)
              .neq('id', step.id)
              .in('status', ['pending', 'running', 'sleeping', 'paused']);

            {
              // Resolve the acting user from the automation's creator so the
              // audit row carries a real user_id instead of NULL.
              let stepActingUserId: string | null = null;

              if (run?.automation_id) {
                const { data: stepAutomation } = await this.db
                  .from('automations')
                  .select('created_by')
                  .eq('id', run.automation_id)
                  .maybeSingle();

                stepActingUserId =
                  (stepAutomation as { created_by?: string } | null)
                    ?.created_by ?? null;
              }

              const stepChanges = {
                node_id: step.node_id,
                node_kind: step.node_kind,
                status: 'failed',
                error_message: message.slice(0, 500),
                retry_count: step.retry_count,
              };

              if (stepActingUserId) {
                void this.auditLogs.logAction(
                  run?.organization_id ?? '',
                  stepActingUserId,
                  'automation_run_step',
                  step.id,
                  'update',
                  stepChanges,
                );
              } else {
                void this.auditLogs.logSystemAction(
                  run?.organization_id ?? '',
                  'automation_run_step',
                  step.id,
                  'update',
                  stepChanges,
                );
              }
            }
          }

          stats.failed++;
        }

        stats.dispatched++;
        if (Date.now() - startedAt > WORKER_BUDGET_MS) break;
      }
    }

    return { workerId, durationMs: Date.now() - startedAt, ...stats };
  }

  // Resolve the user the automation acts as: per-automation override → global service account →
  // automation creator. Shared by the template eval context ({{ context.userId }}) and the handler
  // execution context so both agree on one value.
  private async resolveActingUserId(
    automationId: string,
    definition?: DagDefinition,
  ): Promise<string | null> {
    const perAutomationUserId = definition?.variables?.__runAsUserId as
      | string
      | undefined;
    const serviceAccountId = process.env.AUTOMATION_SERVICE_USER_ID ?? null;
    const pinned = perAutomationUserId ?? serviceAccountId ?? null;

    if (pinned) return pinned;

    const { data: automation } = await this.db
      .from('automations')
      .select('created_by')
      .eq('id', automationId)
      .maybeSingle();

    return (automation as { created_by?: string } | null)?.created_by ?? null;
  }

  private async buildEvalContext(
    run: RunRow,
    step: { run_id: string },
    definition?: DagDefinition,
  ): Promise<EvalContext> {
    const { data: prevSteps } = await this.db
      .from('automation_run_steps')
      .select('node_id, output')
      .eq('run_id', step.run_id)
      .eq('status', 'succeeded');

    const nodes: Record<string, { output: unknown }> = {};
    for (const s of prevSteps ?? []) {
      nodes[(s as { node_id: string; output: unknown }).node_id] = {
        output: (s as { output: unknown }).output,
      };
    }

    return {
      trigger: run.trigger_payload ?? {},
      nodes,
      context: {
        runId: run.id,
        spaceId: run.space_id,
        organizationId: run.organization_id,
        triggerKind: run.trigger_kind,
        userId: await this.resolveActingUserId(run.automation_id, definition),
      },
    };
  }

  private async buildExecutionContext(args: {
    run: RunRow;
    step: {
      id: string;
      node_id: string;
      input: Record<string, unknown>;
      retry_count: number;
    };
    evalCtx: EvalContext;
    definition?: DagDefinition;
    submissionMedia?: SubmissionMediaItem[];
  }): Promise<ExecutionContext> {
    const previousStepOutputs: Record<string, unknown> = {};
    for (const [nodeId, data] of Object.entries(args.evalCtx.nodes)) {
      previousStepOutputs[nodeId] = data.output;
    }

    // Service principal priority: per-automation → global env var → automation creator
    const actingUserId = await this.resolveActingUserId(
      args.run.automation_id,
      args.definition,
    );

    const db = this
      .db as unknown as import('@supabase/supabase-js').SupabaseClient;

    return {
      supabase: db,
      runId: args.run.id,
      automationId: args.run.automation_id,
      spaceId: args.run.space_id,
      organizationId: args.run.organization_id,
      triggerKind: args.run.trigger_kind,
      triggerPayload: args.run.trigger_payload,
      previousStepOutputs,
      actingUserId,
      resolveConnection: async (
        provider: ConnectionProvider,
        connectionId?: string,
      ) => {
        const CONN_SELECT =
          'id, provider, display_name, external_account_id, encrypted_secret, encryption_iv, encryption_tag, metadata, is_revoked';

        let query = db
          .from('automation_connections')
          .select(CONN_SELECT)
          .eq('space_id', args.run.space_id)
          .eq('provider', provider)
          .eq('is_revoked', false);

        if (connectionId) query = query.eq('id', connectionId);

        const { data: primary } = await query.limit(1).maybeSingle();

        // Mutable so we can fall back to a different row if the pinned one is revoked.
        let rawConn = primary;

        console.log('Resolving connection for provider:', provider);

        console.log(rawConn);

        if (!rawConn) {
          console.log(
            `No active ${provider} connection found with${connectionId ? ` id ${connectionId}` : 'outlook'}`,
          );
          if (connectionId) {
            const { data: stale } = await db
              .from('automation_connections')
              .select('is_revoked')
              .eq('id', connectionId)
              .maybeSingle();

            console.log('Stale connection data:', stale);

            if (stale?.is_revoked || !stale) {
              // Pinned connection is revoked OR was deleted entirely — fall back
              // to the newest active connection of the same provider in this space
              // so automations keep working after a reconnect without republishing.
              const { data: fallback } = await db
                .from('automation_connections')
                .select(CONN_SELECT)
                .eq('space_id', args.run.space_id)
                .eq('provider', provider)
                .eq('is_revoked', false)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

              if (fallback) {
                rawConn = fallback;
              } else {
                throw new Error(
                  `The ${provider} connection used by this automation has been revoked — go to Connections and add a new ${provider} connection`,
                );
              }
            }
          }

          if (!rawConn) {
            throw new Error(
              `No active ${provider} connection found for this space — go to Connections and add a ${provider} connection`,
            );
          }
        }

        const c = rawConn as {
          id: string;
          provider: string;
          display_name: string | null;
          external_account_id: string | null;
          encrypted_secret: string;
          encryption_iv: string;
          encryption_tag: string;
          metadata: Record<string, unknown>;
        };

        let decryptedSecret = decryptApiKey(
          c.encrypted_secret,
          c.encryption_iv,
          c.encryption_tag,
        );

        // Microsoft tokens expire in ~1 hour — refresh proactively if within 60s of expiry
        if (c.provider === 'outlook' || c.provider === 'teams') {
          const meta = (c.metadata as Record<string, string | null>) ?? {};
          const expiresAt = meta['token_expires_at']
            ? new Date(meta['token_expires_at'])
            : null;
          const isExpired =
            !expiresAt || expiresAt <= new Date(Date.now() + 60_000);

          if (isExpired) {
            const refreshToken = unpackStoredSecret(meta['refresh_token']);

            if (refreshToken) {
              const tenantId =
                c.provider === 'teams'
                  ? (process.env['AZURE_TENANT_ID'] ?? 'common')
                  : 'consumers'; // Outlook personal MSA needs consumers endpoint for correct mailbox token
              const refreshRes = await fetch(
                `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: process.env['AZURE_CLIENT_ID'] ?? '',
                    client_secret: process.env['AZURE_CLIENT_SECRET'] ?? '',
                  }),
                },
              );

              if (refreshRes.ok) {
                const refreshData = (await refreshRes.json()) as {
                  access_token?: string;
                  expires_in?: number;
                };

                if (refreshData.access_token) {
                  decryptedSecret = refreshData.access_token;

                  // Persist refreshed token — non-blocking so the action isn't delayed
                  const enc = encryptApiKey(decryptedSecret);
                  const newExpiresAt = refreshData.expires_in
                    ? new Date(
                        Date.now() + refreshData.expires_in * 1000,
                      ).toISOString()
                    : null;

                  void db
                    .from('automation_connections')
                    .update({
                      encrypted_secret: enc.encrypted,
                      encryption_iv: enc.iv,
                      encryption_tag: enc.tag,
                      metadata: { ...meta, token_expires_at: newExpiresAt },
                      updated_at: new Date().toISOString(),
                    })
                    .eq('id', c.id);
                }
              }
              // If refresh fails, fall through with the existing token —
              // the action will surface a 401 with a clear error message.
            }
          }
        }

        // Google tokens also expire in ~1 hour — same refresh pattern
        if (
          c.provider === 'google_calendar' ||
          c.provider === 'google_sheets' ||
          c.provider === 'google_drive'
        ) {
          const meta = (c.metadata as Record<string, string | null>) ?? {};
          const expiresAt = meta['token_expires_at']
            ? new Date(meta['token_expires_at'])
            : null;
          const isExpired =
            !expiresAt || expiresAt <= new Date(Date.now() + 60_000);

          if (isExpired) {
            const refreshToken = unpackStoredSecret(meta['refresh_token']);

            if (refreshToken) {
              const refreshRes = await fetch(
                'https://oauth2.googleapis.com/token',
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: refreshToken,
                    client_id: process.env['GOOGLE_CLIENT_ID'] ?? '',
                    client_secret: process.env['GOOGLE_CLIENT_SECRET'] ?? '',
                  }),
                },
              );

              if (refreshRes.ok) {
                const refreshData = (await refreshRes.json()) as {
                  access_token?: string;
                  expires_in?: number;
                };

                if (refreshData.access_token) {
                  decryptedSecret = refreshData.access_token;

                  const enc = encryptApiKey(decryptedSecret);
                  const newExpiresAt = refreshData.expires_in
                    ? new Date(
                        Date.now() + refreshData.expires_in * 1000,
                      ).toISOString()
                    : null;

                  void db
                    .from('automation_connections')
                    .update({
                      encrypted_secret: enc.encrypted,
                      encryption_iv: enc.iv,
                      encryption_tag: enc.tag,
                      metadata: { ...meta, token_expires_at: newExpiresAt },
                      updated_at: new Date().toISOString(),
                    })
                    .eq('id', c.id);
                }
              }
              // If refresh fails, fall through with the existing token.
            }
          }
        }

        // Salesforce access tokens expire — refresh proactively on every run
        if (c.provider === 'salesforce') {
          const meta = (c.metadata as Record<string, string | null>) ?? {};
          const refreshToken = meta['refresh_token'];

          if (refreshToken) {
            try {
              const refreshRes = await fetch(
                'https://login.salesforce.com/services/oauth2/token',
                {
                  method: 'POST',
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    client_id: process.env.SALESFORCE_CLIENT_ID ?? '',
                    client_secret: process.env.SALESFORCE_CLIENT_SECRET ?? '',
                    refresh_token: refreshToken,
                  }),
                },
              );

              if (refreshRes.ok) {
                const refreshData = (await refreshRes.json()) as {
                  access_token?: string;
                  instance_url?: string;
                };

                if (refreshData.access_token) {
                  decryptedSecret = refreshData.access_token;
                  const enc = encryptApiKey(decryptedSecret);

                  void db
                    .from('automation_connections')
                    .update({
                      encrypted_secret: enc.encrypted,
                      encryption_iv: enc.iv,
                      encryption_tag: enc.tag,
                      metadata: {
                        ...meta,
                        instanceUrl:
                          refreshData.instance_url ?? meta['instanceUrl'],
                      },
                      updated_at: new Date().toISOString(),
                    })
                    .eq('id', c.id);
                }
              }
            } catch {
              // fall through with existing token
            }
          }
        }

        return {
          id: c.id,
          provider: c.provider as ConnectionProvider,
          displayName: c.display_name ?? provider,
          externalAccountId: c.external_account_id ?? null,
          decryptedSecret,
          metadata: c.metadata ?? {},
        };
      },
      step: {
        sleep: async (_name: string, ms: number) => {
          await this.queue.markStepSleeping(
            args.step.id,
            new Date(Date.now() + ms),
          );
        },
        run: async <T>(_name: string, fn: () => Promise<T>): Promise<T> => fn(),
      },
      logger: {
        info: (msg: string, meta?: unknown) =>
          this.logger.log(
            `[run:${args.run.id}] ${msg} ${meta ? JSON.stringify(meta) : ''}`,
          ),
        error: (msg: string, meta?: unknown) =>
          this.logger.error(
            `[run:${args.run.id}] ${msg} ${meta ? JSON.stringify(meta) : ''}`,
          ),
      },
      broadcastNotification: (n: Record<string, unknown>) =>
        void this.broadcastService?.broadcastNotification(n),
      submissionMedia: args.submissionMedia,
    };
  }

  /**
   * Formatter that makes `{{ trigger.submission.data }}` honour the Answer format chosen on the Form
   * submitted trigger.
   *
   * Matched by object identity against the payload's own answer set, so ONLY that exact object is
   * reformatted. `{{ trigger.submission.data.email }}` still resolves to the field's value, and
   * Condition/Filter rules keep reading `data` as an object — nothing that works today changes.
   */
  /**
   * Uploads inline `data:` answers so a message can link to them.
   *
   * Camera, signature and multi-photo answers are stored as base64 inside the submission — there is
   * no URL, so no chat client can display them. Each is pushed to the private `attachments` bucket
   * and handed back as a time-limited signed URL, keeping form data from becoming permanently
   * fetchable by anyone holding the link.
   *
   * Best-effort throughout: any failure leaves that answer as its "(image/jpeg)" placeholder rather
   * than failing the run over a picture.
   */
  /**
   * Uploads a step's inline media, but only when that step could actually use it.
   *
   * Uploading on every step of every run would pay for pictures nothing references, so the config is
   * checked for a `submission` mention first — the only way an answer reaches a field.
   */
  private async collectAnswerMedia(
    run: RunRow,
    node: DagNode,
  ): Promise<{ urls: Map<string, string>; items: SubmissionMediaItem[] }> {
    const payload = run.trigger_payload as {
      submission?: SubmissionLike;
    } | null;
    const submission = payload?.submission;

    const empty = { urls: new Map<string, string>(), items: [] };

    if (!submission) return empty;

    const config = JSON.stringify(node.data?.config ?? {});

    if (!config.includes('submission')) return empty;

    return this.uploadInlineMedia(run, submission);
  }

  private async uploadInlineMedia(
    run: RunRow,
    submission: SubmissionLike,
  ): Promise<{ urls: Map<string, string>; items: SubmissionMediaItem[] }> {
    const uploaded = new Map<string, string>();
    const items: SubmissionMediaItem[] = [];
    const answers = submission.data ?? {};

    const inline: string[] = [];

    for (const value of Object.values(answers)) {
      if (typeof value === 'string' && value.startsWith('data:'))
        inline.push(value);
      else if (Array.isArray(value))
        for (const item of value)
          if (typeof item === 'string' && item.startsWith('data:'))
            inline.push(item);
    }

    if (!inline.length) return { urls: uploaded, items };

    let index = 0;

    for (const dataUrl of inline) {
      index += 1;

      // data:<mime>;base64,<payload> — anything else is not something we can store.
      const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);

      if (!match) continue;

      const [, mime, base64] = match;
      const extension = mime.split('/')[1]?.split('+')[0] ?? 'bin';
      const filename = `${index}.${extension}`;
      const path = `automation-media/${run.id}/${filename}`;
      const bytes = Buffer.from(base64, 'base64');
      const item: SubmissionMediaItem = { filename, mimeType: mime, bytes };

      items.push(item);

      try {
        const { error: uploadError } = await this.db.storage
          .from(AUTOMATION_MEDIA_BUCKET)
          .upload(path, bytes, {
            contentType: mime,
            upsert: true,
          });

        if (uploadError) throw new Error(uploadError.message);

        const { data: signed, error: signError } = await this.db.storage
          .from(AUTOMATION_MEDIA_BUCKET)
          .createSignedUrl(path, AUTOMATION_MEDIA_TTL_SECONDS);

        if (signError || !signed?.signedUrl)
          throw new Error(signError?.message ?? 'no signed URL returned');

        uploaded.set(dataUrl, signed.signedUrl);
        item.signedUrl = signed.signedUrl;
      } catch (err: unknown) {
        this.logger.warn(
          `[worker] inline media upload failed for run ${run.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return { urls: uploaded, items };
  }

  private buildAnswerFormatter(
    run: RunRow,
    definition?: DagDefinition,
    media?: Map<string, string>,
  ): ObjectFormatter | undefined {
    const payload = run.trigger_payload as {
      submission?: SubmissionLike;
    } | null;
    const submission = payload?.submission;
    const answers = submission?.data;

    if (!submission || !answers || typeof answers !== 'object')
      return undefined;

    const triggerNode = definition?.nodes?.find(
      (n) =>
        (n.data as { kind?: string } | undefined)?.kind ===
        'app.form.submitted',
    );

    const format =
      (triggerNode?.data as { config?: { answerFormat?: string } } | undefined)
        ?.config?.answerFormat ?? 'text';

    return (value: object) => {
      // Matches the answer set, and the submission wrapper too — otherwise
      // `{{ trigger.submission }}` would fall through to the raw JSON dump, which reproduces
      // password answers in clear text.
      if (value !== answers && value !== submission) return undefined;
      const resolveMedia: MediaResolver | undefined = media?.size
        ? (dataUrl) => media.get(dataUrl)
        : undefined;

      if (format === 'table') return answersTable(submission, resolveMedia);
      if (format === 'json') return answersJson(submission, resolveMedia);

      return answersText(submission, resolveMedia);
    };
  }

  // Text-type task custom fields whose template resolves to an id; one scoped query that never fails the run.
  private async findTextCustomFieldKeys(
    run: RunRow,
    kind: string,
    config: Record<string, unknown>,
    evalCtx: EvalContext,
  ): Promise<ReadonlySet<string> | undefined> {
    const values = config.customFieldValues;
    if (!TASK_CUSTOM_FIELD_KINDS.has(kind) || !isPlainObject(values))
      return undefined;

    const candidates = Object.keys(values).filter((key) => {
      const template = values[key];

      return (
        typeof template === 'string' &&
        placeholderUuids(template, evalCtx).length > 0
      );
    });

    if (candidates.length === 0) return undefined;

    // Text around a placeholder can never form a usable id, so that value reads as text in any field type.
    const mixedKeys = candidates.filter(
      (key) => !BARE_PLACEHOLDER_RE.test(values[key] as string),
    );

    try {
      const { data, error } = await this.db
        .from('custom_fields')
        .select('field_key, field_type')
        .eq('organization_id', run.organization_id)
        .in('field_key', candidates)
        .or(`space_id.is.null,space_id.eq.${run.space_id}`);

      if (error) throw new Error(error.message);

      const rows = (data ?? []) as Array<{
        field_key: string;
        field_type: string;
      }>;

      // Text only when every in-scope field with that key is text; any other type keeps its exact value.
      const textKeys = new Set([
        ...mixedKeys,
        ...candidates.filter(
          (key) =>
            rows.some((r) => r.field_key === key) &&
            rows.every(
              (r) =>
                r.field_key !== key ||
                TEXT_CUSTOM_FIELD_TYPES.has(r.field_type),
            ),
        ),
      ]);

      return textKeys.size > 0 ? textKeys : undefined;
    } catch (err: unknown) {
      this.logger.warn(
        `[worker] custom field type lookup failed for run ${run.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return mixedKeys.length > 0 ? new Set(mixedKeys) : undefined;
    }
  }

  // Readable names for record ids in human-read fields; org-scoped lookups that never fail the run.
  private async buildReadableIdFormatter(
    run: RunRow,
    config: Record<string, unknown>,
    evalCtx: EvalContext,
    humanTextFields?: ReadonlySet<string>,
    textCustomFieldKeys?: ReadonlySet<string>,
  ): Promise<ValueFormatter | undefined> {
    const templates: string[] = [];
    for (const key of humanTextFields ?? []) {
      const template = config[key];
      if (typeof template === 'string')
        templates.push(expandTaskIdToReadable(template));
    }

    const customFieldValues = config.customFieldValues;
    if (isPlainObject(customFieldValues)) {
      for (const key of textCustomFieldKeys ?? []) {
        const template = customFieldValues[key];
        if (typeof template === 'string') templates.push(template);
      }
    }

    const ids = new Set(
      templates.flatMap((template) => placeholderUuids(template, evalCtx)),
    );

    if (ids.size === 0) return undefined;

    const idList = [...ids];
    const lookups: Array<{
      source: string;
      rows: PromiseLike<{ data: unknown; error: { message: string } | null }>;
      toEntry: (row: Record<string, unknown>) => [unknown, string];
    }> = [
      {
        source: 'users',
        rows: this.db
          .from('organization_members')
          .select(
            'user_id, user:users!organization_members_user_id_fkey(id, first_name, last_name, email)',
          )
          .eq('organization_id', run.organization_id)
          .in('user_id', idList),
        toEntry: (row) => {
          const user = isPlainObject(row.user) ? row.user : {};

          return [
            row.user_id,
            joinColumns(user, ['first_name', 'last_name'], ' ') ||
              joinColumns(user, ['email'], ''),
          ];
        },
      },
      ...READABLE_ID_TABLES.map(({ table, columns, parent }) => ({
        source: table,
        rows: this.db
          .from(table)
          .select(
            ['id', ...columns, ...(parent ? [parent.embed] : [])].join(', '),
          )
          .eq(parent?.orgColumn ?? 'organization_id', run.organization_id)
          .in('id', idList),
        toEntry: (row: Record<string, unknown>): [unknown, string] => [
          row.id,
          joinColumns(row, columns, ' — '),
        ],
      })),
      // Only the run's own organization — never another tenant's name.
      ...(ids.has(run.organization_id)
        ? [
            {
              source: 'organizations',
              rows: this.db
                .from('organizations')
                .select('id, name')
                .eq('id', run.organization_id),
              toEntry: (row: Record<string, unknown>): [unknown, string] => [
                row.id,
                joinColumns(row, ['name'], ''),
              ],
            },
          ]
        : []),
    ];

    const settled = await Promise.allSettled(
      lookups.map(async ({ rows, toEntry }) => {
        const { data, error } = await rows;
        if (error) throw new Error(error.message);

        return ((data ?? []) as Array<Record<string, unknown>>).map(toEntry);
      }),
    );

    // Merged in lookup order, so the first table that names an id wins.
    const names = new Map<string, string>();
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.warn(
          `[worker] ${lookups[index].source} name lookup failed for run ${run.id}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        );
        return;
      }

      for (const [id, label] of result.value) {
        if (typeof id === 'string' && label && !names.has(id))
          names.set(id, label);
      }
    });

    if (names.size === 0) return undefined;

    return (value: unknown) => {
      if (typeof value === 'string') return names.get(value);
      if (
        Array.isArray(value) &&
        value.length > 0 &&
        value.every((v): v is string => typeof v === 'string') &&
        value.some((v) => names.has(v))
      ) {
        return value.map((v) => names.get(v) ?? v).join(', ');
      }

      return undefined;
    };
  }

  /**
   * True when at least one `{{ }}` in the template resolved to nothing.
   *
   * `collectPlaceholderValues` drops empties, so comparing counts is what distinguishes "nothing to
   * show" from "resolved to an empty-looking value".
   */
  private hasEmptyPlaceholder(template: string, evalCtx: EvalContext): boolean {
    const total = template.match(PLACEHOLDER_RE)?.length ?? 0;

    return total > collectPlaceholderValues(template, evalCtx).length;
  }

  /**
   * Whether the action itself declares this config key as required.
   *
   * Read from the registered Zod schema rather than a second list here, so the two can never drift.
   * Anything that is not a plain object schema (the export action wraps its object in a refinement)
   * answers "not required" — a wrong guess must never fail a run that would otherwise succeed.
   */
  private isRequiredConfigKey(kind: string, key: string): boolean {
    const schema = this.actionRegistry.get(kind)?.configSchema as
      | {
          shape?: Record<
            string,
            { safeParse: (v: unknown) => { success: boolean } }
          >;
        }
      | undefined;

    const field = schema?.shape?.[key];

    return field ? !field.safeParse(undefined).success : false;
  }

  /**
   * Every config key of this node that a person reads, so an empty `{{ }}` renders as "-" there.
   *
   * The hand-picked {@link HUMAN_TEXT_FIELDS} stays authoritative — it is a union, so no key that
   * behaves correctly today can change. On top of it, any other key the action declares as a plain
   * string is treated as human text unless {@link NON_HUMAN_KEY_RE} says it is an id, date, enum,
   * secret or machine payload. That is what extends the marker to node kinds the list never covered
   * without having to enumerate them one by one.
   *
   * Nested objects are untouched: `resolveConfigTemplates` recurses with an EMPTY set, so
   * `customFieldValues` still SKIPS an unresolved field rather than writing "-" into it.
   */
  private humanTextKeysFor(
    kind: string,
    config: Record<string, unknown>,
  ): ReadonlySet<string> {
    const keys = new Set(HUMAN_TEXT_FIELDS[kind] ?? []);

    const schema = this.actionRegistry.get(kind)?.configSchema as
      | { shape?: Record<string, unknown> }
      | undefined;

    const shape = schema?.shape;

    if (!shape || MACHINE_PAYLOAD_KINDS.has(kind)) return keys;

    for (const key of Object.keys(config)) {
      if (keys.has(key) || NON_HUMAN_KEY_RE.test(key)) continue;
      if (typeof config[key] !== 'string') continue;
      if (this.isPlainStringField(shape[key])) keys.add(key);
    }

    return keys;
  }

  /**
   * Whether a Zod field is a plain string once its wrappers are peeled off.
   *
   * An enum is deliberately NOT a string here: it reaches a CHECK-constrained column, where "-" is a
   * 23514. Anything unrecognised answers "no", because a wrong guess writes a marker into a typed
   * field while the current behaviour merely leaves a visible placeholder.
   */
  private isPlainStringField(field: unknown): boolean {
    let current = field as
      | { _def?: { typeName?: string; innerType?: unknown; schema?: unknown } }
      | undefined;

    for (let depth = 0; current?._def && depth < 5; depth += 1) {
      const typeName = current._def.typeName;

      if (typeName === 'ZodString') return true;
      if (!typeName || !ZOD_WRAPPERS.has(typeName)) return false;

      current = (current._def.innerType ??
        current._def.schema) as typeof current;
    }

    return false;
  }

  private resolveConfigTemplates(
    config: Record<string, unknown>,
    evalCtx: EvalContext,
    humanTextFields: ReadonlySet<string> = new Set(),
    formatObject?: ObjectFormatter,
    formatValue?: ValueFormatter,
    textCustomFieldKeys?: ReadonlySet<string>,
    nodeKind?: string,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string') {
        // In a field a person reads, a bare task id is expanded to "KEY — Summary". Everywhere else
        // the raw value is preserved, because an API field that expects a UUID must receive one.
        const isHumanText = humanTextFields.has(key);
        const source = isHumanText ? expandTaskIdToReadable(value) : value;

        // A required field whose whole value is one empty token would otherwise become "-", i.e. a
        // task literally named "-". Failing here says what is wrong while nothing has been created.
        if (
          isHumanText &&
          nodeKind &&
          BARE_PLACEHOLDER_RE.test(source) &&
          this.hasEmptyPlaceholder(source, evalCtx) &&
          this.isRequiredConfigKey(nodeKind, key)
        ) {
          throw new Error(
            `${nodeKind} (400): "${key}" resolved to nothing for this trigger — the field it points at is empty.`,
          );
        }

        result[key] = substitute(
          source,
          evalCtx,
          formatObject,
          isHumanText ? formatValue : undefined,
          isHumanText ? EMPTY_TEXT_MARKER : undefined,
        );
      } else if (isPlainObject(value)) {
        // Nested objects are machine payloads (webhook bodies, header maps) — never expanded.
        result[key] = this.resolveConfigTemplates(
          value,
          evalCtx,
          new Set(),
          formatObject,
        );

        // Text-type task custom fields are read by people, so a record id there shows as its name.
        if (
          key === 'customFieldValues' &&
          formatValue &&
          textCustomFieldKeys?.size
        ) {
          const resolved = result[key] as Record<string, unknown>;
          for (const fieldKey of textCustomFieldKeys) {
            const template = value[fieldKey];
            if (typeof template === 'string')
              resolved[fieldKey] = substitute(
                template,
                evalCtx,
                formatObject,
                formatValue,
              );
          }
        }
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          typeof item === 'string'
            ? substitute(item, evalCtx, formatObject)
            : item,
        );
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  private async enqueueNextSteps(
    run: RunRow,
    definition: DagDefinition,
    prevStep: {
      step_index: number;
      output?: Record<string, unknown>;
      input: Record<string, unknown>;
    },
    nextNodes: DagNode[],
  ): Promise<void> {
    for (const node of nextNodes) {
      const incomingEdges = definition.edges.filter(
        (e) => e.target === node.id,
      );

      if (incomingEdges.length > 1) {
        const sourceNodeIds = incomingEdges.map((e) => e.source);
        const { data: parentSteps } = await this.db
          .from('automation_run_steps')
          .select('node_id, status, output')
          .eq('run_id', run.id)
          .in('node_id', sourceNodeIds);

        const allSucceeded = sourceNodeIds.every((srcId: string) =>
          parentSteps?.some(
            (s: { node_id: string; status: string }) =>
              s.node_id === srcId && s.status === 'succeeded',
          ),
        );
        if (!allSucceeded) continue;

        const joinInput: Record<string, unknown> = {};
        for (const ps of parentSteps ?? []) {
          joinInput[(ps as { node_id: string }).node_id] = (
            ps as { output: unknown }
          ).output;
        }

        await this.db.from('automation_run_steps').insert({
          run_id: run.id,
          space_id: run.space_id,
          node_id: node.id,
          node_kind: node.data?.kind,
          step_index: prevStep.step_index + 1,
          status: 'pending',
          input: joinInput,
          retry_count: 0,
        });
      } else {
        await this.db.from('automation_run_steps').insert({
          run_id: run.id,
          space_id: run.space_id,
          node_id: node.id,
          node_kind: node.data?.kind,
          step_index: prevStep.step_index + 1,
          status: 'pending',
          input: prevStep.output ?? prevStep.input,
          retry_count: 0,
        });
      }
    }
  }

  // A step may finish executing (leased, in 'running' state) after its run has already ended —
  // e.g. a sibling step failed and marked the whole run failed while this one was mid-flight.
  // Returns true when the run is already terminal, in which case this step's result must NOT be
  // persisted or retried; it's cancelled instead so it doesn't linger "Running" on a failed run
  // or resurrect a downstream branch.
  private async isRunTerminal(runId: string): Promise<boolean> {
    const { data } = await this.db
      .from('automation_runs')
      .select('status')
      .eq('id', runId)
      .maybeSingle();

    const status = (data as { status?: string } | null)?.status;

    return status === 'failed' || status === 'cancelled';
  }

  private async cancelStepForEndedRun(stepId: string): Promise<void> {
    await this.db
      .from('automation_run_steps')
      .update({
        status: 'cancelled',
        error_message: 'Skipped — run already ended',
        lease_until: null,
        worker_id: null,
        finished_at: new Date().toISOString(),
      })
      .eq('id', stepId);
  }

  private async checkAndMarkRunComplete(
    runId: string,
    organizationId?: string,
  ): Promise<void> {
    const { count } = await this.db
      .from('automation_run_steps')
      .select('id', { count: 'exact', head: true })
      .eq('run_id', runId)
      .in('status', ['pending', 'running', 'sleeping', 'paused']);

    if ((count ?? 0) > 0) return;

    const { data: failedStep } = await this.db
      .from('automation_run_steps')
      .select('error_message, node_id')
      .eq('run_id', runId)
      .eq('status', 'failed')
      .limit(1)
      .maybeSingle();

    const { data: runRow } = await this.db
      .from('automation_runs')
      .select('started_at, automation_id')
      .eq('id', runId)
      .maybeSingle();

    const durationMs = runRow?.started_at
      ? Date.now() -
        new Date((runRow as { started_at: string }).started_at).getTime()
      : null;

    await this.db
      .from('automation_runs')
      .update({
        status: failedStep ? 'failed' : 'succeeded',
        finished_at: new Date().toISOString(),
        duration_ms: durationMs,
        error_message:
          (failedStep as { error_message?: string } | null)?.error_message ??
          null,
        error_step_id:
          (failedStep as { node_id?: string } | null)?.node_id ?? null,
      })
      .eq('id', runId);

    if (organizationId) {
      const fs = failedStep as {
        error_message?: string;
        node_id?: string;
      } | null;

      // Resolve the acting user from the automation's creator so audit log
      // rows are attributed to a real user_id rather than NULL.
      let actingUserId: string | null = null;
      const automationId = (runRow as { automation_id?: string } | null)
        ?.automation_id;

      if (automationId) {
        const { data: automation } = await this.db
          .from('automations')
          .select('created_by')
          .eq('id', automationId)
          .maybeSingle();

        actingUserId =
          (automation as { created_by?: string } | null)?.created_by ?? null;
      }

      const changes = {
        status: fs ? 'failed' : 'succeeded',
        duration_ms: durationMs,
        ...(fs
          ? { error_message: fs.error_message, error_step_id: fs.node_id }
          : {}),
      };

      if (actingUserId) {
        void this.auditLogs.logAction(
          organizationId,
          actingUserId,
          'automation_run',
          runId,
          'update',
          changes,
        );
      } else {
        void this.auditLogs.logSystemAction(
          organizationId,
          'automation_run',
          runId,
          'update',
          changes,
        );
      }
    }
  }

  private async dispatchAction(
    kind: string,
    config: Record<string, unknown>,
    input: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<unknown> {
    return this.actionRegistry.dispatch(kind, config, input, ctx);
  }
}
