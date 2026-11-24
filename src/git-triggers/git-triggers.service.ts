/**
 * @fileoverview Runtime for the `git_branch_created` workflow trigger.
 *
 * Receives a generic "branch created" webhook (repository id + branch name),
 * finds every ACTIVE-workflow transition carrying a matching `git_branch_created`
 * trigger (JSONB containment on `workflow_transitions.triggers`, narrowed in JS
 * by required `repo_id` + branch glob), extracts the task key from the branch
 * name (e.g. `feature/DEFAULT-T29-login` → `DEFAULT-T29`), resolves that task in
 * the trigger's organization, synthesizes a {@link RequestUser} from the
 * workflow's `created_by`, and fires the transition through the engine via the
 * {@link WORKFLOW_ENGINE_SERVICE} DI token.
 *
 * Design: every "not firable" rejection (wrong source status, failed
 * condition/validator, transition-not-in-the-task's-workflow, decision dead-end,
 * optimistic-lock loss) is a SILENT no-op. The endpoint always accepts (202) and
 * never 500s on a per-trigger failure, so a git provider never retry-storms.
 * @module src/git-triggers/git-triggers.service
 * @author Ala Bera
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { decryptApiKey } from '../lib/crypto/encryption';
import { normalizeRuleConfig } from '../workflow-engine/handlers/rule-config';
import type { IWorkflowEngineRuntime } from '../workflow-triggers/workflow-engine.contract';
import { WORKFLOW_ENGINE_SERVICE } from '../workflow-triggers/workflow-engine.contract';
import { globMatch } from './glob-match.util';

interface IGitTriggerCfg {
  type: string;
  branch_pattern?: string;
  target_branch?: string;
  repo_id?: string;
  [key: string]: unknown;
}

interface IWorkflowJoin {
  id: string;
  organization_id: string;
  space_id: string | null;
  is_archived: boolean | null;
  is_active: boolean | null;
  is_draft?: boolean | null;
  created_by: string | null;
}

interface ITransitionRow {
  id: string;
  workflow_id: string;
  triggers: IGitTriggerCfg[] | null;
  workflows: IWorkflowJoin | IWorkflowJoin[] | null;
}

interface IUserRow {
  id: string;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
}

// Outcome of a single per-transition git-trigger evaluation, persisted to
// `workflow_github_trigger_events` for observability.
type GitTriggerOutcome = 'fired' | 'no_op' | 'error' | 'no_task';

// Task keys are `<SPACEKEY>-T<n>` (e.g. DEFAULT-T29) or the no-space fallback
// `TASK-<n>`. Extract case-insensitively; the value is uppercased for the
// org-unique `tasks.key` lookup (keys are stored uppercase).
const TASK_KEY_RE = /[A-Za-z][A-Za-z0-9]*-T\d+|TASK-\d+/i;

// Bounded in-memory dedupe of GitHub delivery ids (`x-github-delivery`). GitHub
// retries deliveries on any non-2xx / timeout; without this the same event would
// re-fire transitions. Per-process only — a duplicate across a restart is rare.
const RECENT_DELIVERIES = new Set<string>();
const MAX_RECENT_DELIVERIES = 2000;

@Injectable()
export class GitTriggersService {
  private static readonly TABLE = 'workflow_transitions';
  private readonly logger = new Logger(GitTriggersService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    // Engine may not be wired yet (parallel phases); @Optional() keeps boot
    // clean and we simply fire 0 transitions when it's absent.
    @Optional()
    @Inject(WORKFLOW_ENGINE_SERVICE)
    private readonly engine?: IWorkflowEngineRuntime,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Handle a "git branch created" webhook and fire every matching workflow
   * transition. Always resolves (202-shaped); only a malformed body or a failed
   * HMAC throws (400 / 401).
   *
   * @throws BadRequestException when repository or branch is missing.
   * @throws UnauthorizedException when HMAC verification fails (server secret set).
   */
  async handleBranchCreated(
    args: {
      payload: Record<string, unknown>;
      signature?: string;
      // Set only for internal calls from handleGithubEvent, which already
      // authenticated the delivery via GitHub's x-hub-signature-256 scheme.
      // Skips the generic x-workflow-signature re-verification below (whose
      // scheme + header differ), so a set WORKFLOW_GIT_TRIGGER_SECRET does not
      // 401 the native GitHub path.
      trusted?: boolean;
    },
    logSource?: { deliveryId?: string; eventName: string },
  ): Promise<{ accepted: true; fired: number }> {
    const { payload, signature } = args;

    // 1) Required generic-payload fields.
    const repo = this.readString(
      payload.repository_id ?? payload.repository ?? payload.repo,
    );
    const branchRaw = this.readString(payload.branch ?? payload.ref);

    if (!repo || !branchRaw) {
      throw new BadRequestException(
        'payload must include a repository (repository_id) and a branch name',
      );
    }
    // Providers often send `refs/heads/feature/x`; reduce to the branch name.
    const branch = branchRaw.replace(/^refs\/heads\//, '');

    // 2) Optional HMAC. When a server secret is configured the signature is
    //    REQUIRED and verified; otherwise verification is skipped (first-party /
    //    trusted network only) and we log a warning.
    const serverSecret = process.env.WORKFLOW_GIT_TRIGGER_SECRET;

    if (serverSecret && !args.trusted) {
      this.verifySignature(serverSecret, payload, signature);
    } else if (!serverSecret) {
      this.logger.warn(
        'WORKFLOW_GIT_TRIGGER_SECRET not set — git-branch-created webhook accepted without signature verification',
      );
    }

    // Engine gate — accept but fire nothing when the runtime is absent.
    if (!this.engine) {
      this.logger.warn('Engine runtime not available; git trigger fired 0');

      return { accepted: true, fired: 0 };
    }

    // 3) JSONB-containment pre-filter for git_branch_created triggers.
    const lookup = await this.client
      .from(GitTriggersService.TABLE)
      .select(
        'id, workflow_id, triggers, workflows!inner(id, organization_id, space_id, is_archived, is_active, is_draft, created_by)',
      )
      .filter(
        'triggers',
        'cs',
        JSON.stringify([{ type: 'git_branch_created' }]),
      );

    if (lookup.error) throw new BadRequestException(lookup.error.message);
    const rows = (lookup.data ?? []) as ITransitionRow[];

    // 4) Fire each matching (transition, task) pair at most once.
    const firedPairs = new Set<string>();
    let fired = 0;

    for (const row of rows) {
      const workflow = this.unwrapWorkflow(row);

      // Runtime-only: git has no per-trigger secret fallback, so draft /
      // inactive / archived workflows are ignored entirely.
      if (
        !workflow ||
        workflow.is_archived ||
        workflow.is_active === false ||
        workflow.is_draft === true
      ) {
        continue;
      }

      if (!this.transitionMatches(row, repo, branch)) continue;

      // 5) Resolve the target task from the branch name (org-scoped).
      const taskKey = this.extractTaskKey(branch);

      // Per-matched-row logging base — only present for real GitHub deliveries.
      const base = logSource
        ? {
            organizationId: workflow.organization_id,
            spaceId: workflow.space_id ?? null,
            workflowId: workflow.id,
            transitionId: row.id,
            deliveryId: logSource.deliveryId,
            eventName: logSource.eventName,
            repoFullName: repo,
            branch,
            taskKey,
          }
        : null;

      if (!taskKey) {
        if (base) this.logTriggerEvent({ ...base, outcome: 'no_task' });

        continue;
      }

      const taskId = await this.resolveTaskId(
        taskKey,
        workflow.organization_id,
      );

      if (!taskId) {
        if (base) {
          this.logTriggerEvent({
            ...base,
            outcome: 'no_task',
            message: 'task not found for key',
          });
        }

        continue;
      }

      const dedupeKey = `${row.id}:${taskId}`;

      if (firedPairs.has(dedupeKey)) continue;
      firedPairs.add(dedupeKey);

      // 6) Acting identity from the workflow creator.
      if (!workflow.created_by) {
        this.logger.warn(
          `Workflow ${workflow.id} has no created_by — cannot resolve identity; skipping`,
        );

        if (base) {
          this.logTriggerEvent({
            ...base,
            outcome: 'error',
            message: 'workflow has no created_by',
          });
        }

        continue;
      }
      const user = await this.resolveRequestUser(
        workflow.created_by,
        workflow.organization_id,
      );

      // 7) Fire. "Not firable" rejections are expected no-ops; the engine
      //    self-validates that the transition belongs to the task's workflow
      //    and is available from its current status.
      try {
        await this.engine.executeTransition({
          taskId,
          transitionId: row.id,
          screenInput: {},
          user,
          executionId: randomUUID(),
        });
        fired++;

        if (base) this.logTriggerEvent({ ...base, outcome: 'fired' });
      } catch (err) {
        if (this.isNoOpError(err)) {
          this.logger.debug(
            `git trigger no-op (task ${taskId}, transition ${row.id}): ${(err as Error).message}`,
          );

          if (base) {
            this.logTriggerEvent({
              ...base,
              outcome: 'no_op',
              message: (err as Error).message,
            });
          }
        } else {
          this.logger.warn(
            `git trigger execution error (task ${taskId}, transition ${row.id}): ${
              (err as Error)?.message ?? String(err)
            }`,
          );

          if (base) {
            this.logTriggerEvent({
              ...base,
              outcome: 'error',
              message: (err as Error)?.message ?? String(err),
            });
          }
        }
      }
    }

    return { accepted: true, fired };
  }

  /**
   * Handle a "git pull request merged" webhook and fire every matching workflow
   * transition. Mirrors {@link handleBranchCreated}, with two PR-specific twists:
   * the task key is taken from the PR's SOURCE (head) branch — the target/base
   * branch (e.g. `main`) rarely carries one — and matching uses the optional
   * `target_branch` (base) instead of a branch glob. Always resolves
   * (202-shaped); only a malformed body or a failed HMAC throws (400 / 401).
   *
   * @throws BadRequestException when repository or source branch is missing.
   * @throws UnauthorizedException when HMAC verification fails (server secret set).
   */
  async handlePrMerged(
    args: {
      payload: Record<string, unknown>;
      signature?: string;
      // See handleBranchCreated — set for already-authenticated internal calls.
      trusted?: boolean;
    },
    logSource?: { deliveryId?: string; eventName: string },
  ): Promise<{ accepted: true; fired: number }> {
    const { payload, signature } = args;

    // 1) Required generic-payload fields. The task key lives on the PR's SOURCE
    //    (head) branch; the base/target branch is used only for matching.
    const repo = this.readString(
      payload.repository_id ?? payload.repository ?? payload.repo,
    );
    const sourceRaw = this.readString(
      payload.source_branch ??
        payload.head_branch ??
        payload.head_ref ??
        payload.branch,
    );

    if (!repo || !sourceRaw) {
      throw new BadRequestException(
        'payload must include a repository (repository_id) and a source branch (source_branch)',
      );
    }

    // Only genuine merges fire. Callers may omit `merged` (the endpoint already
    // means "merged"); an explicit `false` (PR closed unmerged) is a no-op.
    if (payload.merged === false) {
      return { accepted: true, fired: 0 };
    }

    // Providers often send `refs/heads/...`; reduce to the branch name.
    const sourceBranch = sourceRaw.replace(/^refs\/heads\//, '');
    const baseRaw = this.readString(
      payload.target_branch ?? payload.base_branch ?? payload.base_ref,
    );
    const baseBranch = baseRaw ? baseRaw.replace(/^refs\/heads\//, '') : null;

    // 2) Optional HMAC (same scheme as branch-created).
    const serverSecret = process.env.WORKFLOW_GIT_TRIGGER_SECRET;

    if (serverSecret && !args.trusted) {
      this.verifySignature(serverSecret, payload, signature);
    } else if (!serverSecret) {
      this.logger.warn(
        'WORKFLOW_GIT_TRIGGER_SECRET not set — git-pr-merged webhook accepted without signature verification',
      );
    }

    // Engine gate — accept but fire nothing when the runtime is absent.
    if (!this.engine) {
      this.logger.warn('Engine runtime not available; git trigger fired 0');

      return { accepted: true, fired: 0 };
    }

    // 3) JSONB-containment pre-filter for git_pr_merged triggers.
    const lookup = await this.client
      .from(GitTriggersService.TABLE)
      .select(
        'id, workflow_id, triggers, workflows!inner(id, organization_id, space_id, is_archived, is_active, is_draft, created_by)',
      )
      .filter('triggers', 'cs', JSON.stringify([{ type: 'git_pr_merged' }]));

    if (lookup.error) throw new BadRequestException(lookup.error.message);
    const rows = (lookup.data ?? []) as ITransitionRow[];

    // 4) Fire each matching (transition, task) pair at most once.
    const firedPairs = new Set<string>();
    let fired = 0;

    for (const row of rows) {
      const workflow = this.unwrapWorkflow(row);

      // Runtime-only: draft / inactive / archived workflows are ignored.
      if (
        !workflow ||
        workflow.is_archived ||
        workflow.is_active === false ||
        workflow.is_draft === true
      ) {
        continue;
      }

      if (!this.prTransitionMatches(row, repo, baseBranch)) continue;

      // 5) Resolve the target task from the SOURCE branch name (org-scoped).
      const taskKey = this.extractTaskKey(sourceBranch);

      // Per-matched-row logging base — only present for real GitHub deliveries.
      // PR events log the SOURCE (head) branch, which carries the task key.
      const base = logSource
        ? {
            organizationId: workflow.organization_id,
            spaceId: workflow.space_id ?? null,
            workflowId: workflow.id,
            transitionId: row.id,
            deliveryId: logSource.deliveryId,
            eventName: logSource.eventName,
            repoFullName: repo,
            branch: sourceBranch,
            taskKey,
          }
        : null;

      if (!taskKey) {
        if (base) this.logTriggerEvent({ ...base, outcome: 'no_task' });

        continue;
      }

      const taskId = await this.resolveTaskId(
        taskKey,
        workflow.organization_id,
      );

      if (!taskId) {
        if (base) {
          this.logTriggerEvent({
            ...base,
            outcome: 'no_task',
            message: 'task not found for key',
          });
        }

        continue;
      }

      const dedupeKey = `${row.id}:${taskId}`;

      if (firedPairs.has(dedupeKey)) continue;
      firedPairs.add(dedupeKey);

      // 6) Acting identity from the workflow creator.
      if (!workflow.created_by) {
        this.logger.warn(
          `Workflow ${workflow.id} has no created_by — cannot resolve identity; skipping`,
        );

        if (base) {
          this.logTriggerEvent({
            ...base,
            outcome: 'error',
            message: 'workflow has no created_by',
          });
        }

        continue;
      }
      const user = await this.resolveRequestUser(
        workflow.created_by,
        workflow.organization_id,
        'workflow_trigger_git_pr_merged',
      );

      // 7) Fire. "Not firable" rejections are expected no-ops; the engine
      //    self-validates the transition against the task's workflow + status.
      try {
        await this.engine.executeTransition({
          taskId,
          transitionId: row.id,
          screenInput: {},
          user,
          executionId: randomUUID(),
        });
        fired++;

        if (base) this.logTriggerEvent({ ...base, outcome: 'fired' });
      } catch (err) {
        if (this.isNoOpError(err)) {
          this.logger.debug(
            `git trigger no-op (task ${taskId}, transition ${row.id}): ${(err as Error).message}`,
          );

          if (base) {
            this.logTriggerEvent({
              ...base,
              outcome: 'no_op',
              message: (err as Error).message,
            });
          }
        } else {
          this.logger.warn(
            `git trigger execution error (task ${taskId}, transition ${row.id}): ${
              (err as Error)?.message ?? String(err)
            }`,
          );

          if (base) {
            this.logTriggerEvent({
              ...base,
              outcome: 'error',
              message: (err as Error)?.message ?? String(err),
            });
          }
        }
      }
    }

    return { accepted: true, fired };
  }

  /**
   * Receiver for native GitHub webhook deliveries
   * (POST /api/v1/git-triggers/github/events). Verifies `x-hub-signature-256`
   * against the per-repo secret stored in `workflow_github_webhooks`, then
   * normalizes the payload and dispatches to the existing matchers: a `create`
   * event with `ref_type:'branch'` → {@link handleBranchCreated}; a merged
   * `pull_request` → {@link handlePrMerged}. `ping` is acknowledged. Duplicate
   * deliveries (GitHub retries) are dropped by `x-github-delivery`. Always
   * resolves (the controller returns 204) except a bad/absent signature (401).
   *
   * @throws BadRequestException on a malformed body / missing repository.
   * @throws UnauthorizedException when no registered repo secret verifies the signature.
   */
  async handleGithubEvent(args: {
    eventName: string | undefined;
    deliveryId: string | undefined;
    signature: string | undefined;
    rawBody: string;
  }): Promise<{ accepted: true; fired: number }> {
    const { eventName, deliveryId, signature, rawBody } = args;

    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new BadRequestException('Invalid JSON body');
    }

    const repository = payload.repository as
      | { full_name?: string; id?: number }
      | undefined;
    const repoFullName = this.readString(repository?.full_name);

    if (!repoFullName) {
      throw new BadRequestException('payload missing repository.full_name');
    }

    // Authenticate the delivery against the per-repo secret we registered. GitHub
    // sends one signed delivery per hook; the row whose secret validates is the
    // right connection. (Signature is over the RAW bytes — never re-serialize.)
    const authed = await this.verifyGithubDelivery(
      repoFullName,
      rawBody,
      signature,
    );

    if (!authed) {
      throw new UnauthorizedException('Invalid GitHub webhook signature');
    }

    // GitHub connectivity check (sent once on hook creation).
    if (eventName === 'ping') return { accepted: true, fired: 0 };

    // Drop duplicate retries (per-process).
    if (deliveryId) {
      if (RECENT_DELIVERIES.has(deliveryId)) {
        return { accepted: true, fired: 0 };
      }

      RECENT_DELIVERIES.add(deliveryId);

      if (RECENT_DELIVERIES.size > MAX_RECENT_DELIVERIES) {
        const keep = Array.from(RECENT_DELIVERIES).slice(
          -Math.floor(MAX_RECENT_DELIVERIES / 2),
        );

        RECENT_DELIVERIES.clear();
        keep.forEach((d) => RECENT_DELIVERIES.add(d));
      }
    }

    // `create` — a ref was created. Only branches fire (skip tags).
    if (eventName === 'create') {
      if (this.readString(payload.ref_type) !== 'branch') {
        return { accepted: true, fired: 0 };
      }

      const branch = this.readString(payload.ref);

      if (!branch) return { accepted: true, fired: 0 };

      return this.handleBranchCreated(
        {
          payload: { repository_id: repoFullName, branch },
          // Already authenticated by verifyGithubDelivery above.
          trusted: true,
        },
        { deliveryId, eventName: 'create' },
      );
    }

    // `pull_request` closed + merged → PR merged.
    if (eventName === 'pull_request') {
      const action = this.readString(payload.action);
      const pr = payload.pull_request as
        | { merged?: boolean; base?: { ref?: string }; head?: { ref?: string } }
        | undefined;

      if (action !== 'closed' || pr?.merged !== true) {
        return { accepted: true, fired: 0 };
      }

      return this.handlePrMerged(
        {
          payload: {
            repository_id: repoFullName,
            target_branch: pr?.base?.ref,
            source_branch: pr?.head?.ref,
            merged: true,
          },
          // Already authenticated by verifyGithubDelivery above.
          trusted: true,
        },
        { deliveryId, eventName: 'pull_request' },
      );
    }

    // Any other event type is accepted but ignored.
    return { accepted: true, fired: 0 };
  }

  /**
   * Verify a GitHub `x-hub-signature-256` (`sha256=<hex>`) over the RAW request
   * body against every registered secret for the repo (more than one org may
   * watch the same public repo — each hook has its own secret). Returns true when
   * any secret validates, and best-effort touches that row's `last_delivery_at`.
   */
  private async verifyGithubDelivery(
    repoFullName: string,
    rawBody: string,
    signature: string | undefined,
  ): Promise<boolean> {
    if (!signature) return false;

    const provided = signature.startsWith('sha256=')
      ? signature.slice('sha256='.length)
      : signature;

    // Constant-time compare of `provided` against HMAC-SHA256(rawBody, secret) —
    // GitHub's own scheme (raw request bytes). NOT verifySignature(), which hashes
    // JSON.stringify(payload) for the generic x-workflow-signature endpoints.
    const matches = (secret: string): boolean => {
      const expected = createHmac('sha256', secret)
        .update(rawBody, 'utf8')
        .digest('hex');

      return (
        provided.length === expected.length &&
        timingSafeEqual(
          Buffer.from(provided, 'utf8'),
          Buffer.from(expected, 'utf8'),
        )
      );
    };

    // 1) Per-repo secrets registered by the app (space-scoped auto-registration).
    //    Tried first; a match best-effort touches that row's last_delivery_at.
    const rows = await this.client
      .from('workflow_github_webhooks')
      .select('id, secret_encrypted, secret_iv, secret_tag')
      .ilike('repo_full_name', repoFullName);

    if (!rows.error && rows.data?.length) {
      for (const row of rows.data as Array<{
        id: string;
        secret_encrypted: string;
        secret_iv: string;
        secret_tag: string;
      }>) {
        let secret: string;

        try {
          secret = decryptApiKey(
            row.secret_encrypted,
            row.secret_iv,
            row.secret_tag,
          );
        } catch {
          continue;
        }

        if (matches(secret)) {
          void Promise.resolve(
            this.client
              .from('workflow_github_webhooks')
              .update({ last_delivery_at: new Date().toISOString() })
              .eq('id', row.id),
          ).catch(() => {});

          return true;
        }
      }
    }

    // 2) Optional shared-secret fallback for hand-made / org-scoped hooks the app
    //    can't auto-register (mirrors the generic endpoints' WORKFLOW_GIT_TRIGGER_SECRET
    //    at :141-149). A signature is still REQUIRED (guarded above), so this never
    //    trusts an unsigned delivery.
    const envSecret = process.env.WORKFLOW_GIT_TRIGGER_SECRET;

    if (envSecret && matches(envSecret)) return true;

    return false;
  }

  /**
   * True when the transition carries a `git_branch_created` trigger whose
   * required `repo_id` matches the webhook repo (case-insensitive) and whose
   * `branch_pattern` glob matches the branch.
   */
  private transitionMatches(
    row: ITransitionRow,
    repo: string,
    branch: string,
  ): boolean {
    const triggers = Array.isArray(row.triggers) ? row.triggers : [];

    for (const trig of triggers) {
      const cfg = normalizeRuleConfig(trig) as IGitTriggerCfg;

      if (cfg?.type !== 'git_branch_created') continue;

      const cfgRepo = this.readString(cfg.repo_id);
      const cfgPattern = this.readString(cfg.branch_pattern);

      // repo_id + branch_pattern are both required for this trigger.
      if (!cfgRepo || !cfgPattern) continue;
      if (cfgRepo.trim().toLowerCase() !== repo.trim().toLowerCase()) continue;
      if (!globMatch(cfgPattern, branch)) continue;

      return true;
    }

    return false;
  }

  /**
   * True when the transition carries a `git_pr_merged` trigger whose REQUIRED
   * `repo_id` matches the webhook repo (case-insensitive) and whose optional
   * `target_branch` (the PR base branch) matches when set — empty ⇒ any base.
   */
  private prTransitionMatches(
    row: ITransitionRow,
    repo: string,
    base: string | null,
  ): boolean {
    const triggers = Array.isArray(row.triggers) ? row.triggers : [];

    for (const trig of triggers) {
      const cfg = normalizeRuleConfig(trig) as IGitTriggerCfg;

      if (cfg?.type !== 'git_pr_merged') continue;

      const cfgRepo = this.readString(cfg.repo_id);

      // repo_id is REQUIRED for this trigger — skip configs that lack it.
      if (!cfgRepo) continue;
      if (cfgRepo.trim().toLowerCase() !== repo.trim().toLowerCase()) continue;

      // target_branch is optional: empty ⇒ any base branch; set ⇒ must match.
      const cfgTarget = this.readString(cfg.target_branch);

      if (cfgTarget) {
        if (!base) continue;
        if (cfgTarget.trim().toLowerCase() !== base.trim().toLowerCase()) {
          continue;
        }
      }

      return true;
    }

    return false;
  }

  /** Expected "transition not firable / rejected" exceptions → silent no-op. */
  private isNoOpError(err: unknown): boolean {
    return (
      err instanceof BadRequestException ||
      err instanceof NotFoundException ||
      err instanceof ForbiddenException ||
      err instanceof UnprocessableEntityException ||
      err instanceof ConflictException
    );
  }

  /** First task-key-shaped token in the branch name, uppercased; else null. */
  private extractTaskKey(branch: string): string | null {
    const m = branch.match(TASK_KEY_RE);

    return m ? m[0].toUpperCase() : null;
  }

  /**
   * Org-scoped task lookup by key. `tasks.key` is UNIQUE per organization
   * (idx_tasks_key_unique on (organization_id, key)), so this returns at most
   * one row — space_id is not needed to disambiguate.
   */
  private async resolveTaskId(
    key: string,
    organizationId: string,
  ): Promise<string | null> {
    const r = await this.client
      .from('tasks')
      .select('id')
      .eq('key', key)
      .eq('organization_id', organizationId)
      .maybeSingle();

    if (r.error) {
      this.logger.warn(`task lookup failed for ${key}: ${r.error.message}`);

      return null;
    }

    return (r.data as { id: string } | null)?.id ?? null;
  }

  private readString(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
  }

  private unwrapWorkflow(row: ITransitionRow): IWorkflowJoin | null {
    if (!row.workflows) return null;

    return Array.isArray(row.workflows)
      ? (row.workflows[0] ?? null)
      : row.workflows;
  }

  /**
   * Verify an HMAC-SHA256 signature over the JSON-stringified payload. Accepts
   * both the bare hex digest and the `sha256=<hex>` prefix. Timing-safe.
   */
  private verifySignature(
    key: string,
    payload: Record<string, unknown>,
    signature: string | undefined,
  ): void {
    if (!signature) throw new UnauthorizedException('Invalid HMAC signature');

    const provided = signature.startsWith('sha256=')
      ? signature.slice('sha256='.length)
      : signature;
    const expected = createHmac('sha256', key)
      .update(JSON.stringify(payload))
      .digest('hex');

    if (provided.length !== expected.length) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }
    if (
      !timingSafeEqual(
        Buffer.from(provided, 'utf8'),
        Buffer.from(expected, 'utf8'),
      )
    ) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }
  }

  /**
   * Synthesize the {@link RequestUser} the engine expects from a
   * `public.users.id`, org-scoped to the workflow's organization. Falls back to
   * a minimal system identity when the row can't be loaded.
   */
  private async resolveRequestUser(
    userId: string,
    organizationId: string,
    firedBy = 'workflow_trigger_git_branch_created',
  ): Promise<RequestUser> {
    const r = await this.client
      .from('users')
      .select('id, email, role, is_active')
      .eq('id', userId)
      .maybeSingle();

    const data = r.data as IUserRow | null;

    return {
      authUserId: userId,
      userId,
      email: data?.email ?? 'workflow-trigger@system.local',
      organizationId,
      memberships: [],
      role: data?.role ?? null,
      isActive: data?.is_active ?? true,
      appMetadata: { fired_by: firedBy },
    };
  }

  /**
   * Best-effort, non-blocking audit insert of a single per-transition git-trigger
   * outcome into `workflow_github_trigger_events`. Fire-and-forget: a failed
   * insert is logged at warn level and MUST NEVER affect transition firing.
   */
  private logTriggerEvent(row: {
    organizationId: string;
    spaceId: string | null;
    workflowId: string | null;
    transitionId: string | null;
    deliveryId?: string;
    eventName: string;
    repoFullName: string;
    branch: string | null;
    taskKey: string | null;
    outcome: GitTriggerOutcome;
    message?: string;
  }): void {
    void Promise.resolve(
      this.client.from('workflow_github_trigger_events').insert({
        organization_id: row.organizationId,
        space_id: row.spaceId,
        workflow_id: row.workflowId,
        transition_id: row.transitionId,
        delivery_id: row.deliveryId ?? null,
        event_name: row.eventName,
        repo_full_name: row.repoFullName,
        branch: row.branch,
        task_key: row.taskKey,
        outcome: row.outcome,
        message: row.message ?? null,
      }),
    ).catch((e: unknown) =>
      this.logger.warn(`trigger-event log failed: ${(e as Error).message}`),
    );
  }
}
