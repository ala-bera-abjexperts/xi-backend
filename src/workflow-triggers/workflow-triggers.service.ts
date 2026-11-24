/**
 * @fileoverview Service for handling inbound workflow-trigger webhooks. Resolves
 * the target transition row by per-trigger shared secret using a JSONB
 * containment pre-filter against `workflow_transitions.triggers`, then
 * narrows in JS to the exact secret match. Verifies the parent workflow is
 * active + not archived, optionally validates an HMAC signature, synthesizes
 * a {@link RequestUser} from trigger config or workflow `created_by`, and
 * forwards execution to the runtime engine through the
 * {@link WORKFLOW_ENGINE_SERVICE} DI token. When the engine is not yet
 * registered (parallel phases) the service throws 503.
 * @module src/workflow-triggers/workflow-triggers.service
 * @author Rajbha Manek
 */

import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import {
  BadRequestException,
  GoneException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { normalizeRuleConfig } from '../workflow-engine/handlers/rule-config';
import type { IWorkflowEngineRuntime } from './workflow-engine.contract';
import { WORKFLOW_ENGINE_SERVICE } from './workflow-engine.contract';

interface ITriggerCfg {
  type: string;
  slug?: string;
  secret?: string;
  require_signature?: boolean;
  fire_as_user_id?: string;
  task_id?: string;
  [key: string]: unknown;
}

interface ITransitionRow {
  id: string;
  workflow_id: string;
  triggers: ITriggerCfg[] | null;
  workflows:
    | {
        id: string;
        organization_id: string;
        is_archived: boolean | null;
        is_active: boolean | null;
        is_draft?: boolean | null;
        created_by: string | null;
      }
    | {
        id: string;
        organization_id: string;
        is_archived: boolean | null;
        is_active: boolean | null;
        is_draft?: boolean | null;
        created_by: string | null;
      }[]
    | null;
}

interface IUserRow {
  id: string;
  email: string | null;
  role: string | null;
  is_active: boolean | null;
}

@Injectable()
export class WorkflowTriggersService {
  private static readonly TABLE = 'workflow_transitions';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    // Phase B's engine may not be wired yet during parallel phases; @Optional()
    // lets boot succeed without it and we return 503 from the inbound path.
    @Optional()
    @Inject(WORKFLOW_ENGINE_SERVICE)
    private readonly engine?: IWorkflowEngineRuntime,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Resolve and execute an inbound webhook for a workflow trigger.
   *
   * Algorithm:
   *   1. JSONB-containment query for any transition whose `triggers` array
   *      contains an object with `type='inbound_webhook'`. Filter in JS to
   *      the exact secret match (Postgres `@>` is a coarse pre-filter).
   *   2. Refuse if the parent workflow is archived or inactive.
   *   3. Optional HMAC verification when `cfg.require_signature=true`.
   *   4. If the runtime engine is absent → 503.
   *   5. Resolve the calling user (cfg.fire_as_user_id or workflow.created_by).
   *   6. Generate a fresh execution_id and forward to the engine.
   *
   * @throws NotFoundException when no trigger matches the secret.
   * @throws GoneException when the parent workflow is archived/inactive (410).
   * @throws UnauthorizedException when HMAC verification fails (401).
   * @throws BadRequestException when `payload.task_id` is missing.
   * @throws ServiceUnavailableException when the engine runtime is absent (503).
   */
  async handleInbound(args: {
    secret: string;
    payload: Record<string, unknown>;
    signature?: string;
  }): Promise<{ accepted: true; execution_id: string }> {
    const { secret, payload, signature } = args;

    // 1) Locate the candidate transitions via JSONB containment. Postgres
    //    can quickly narrow on `triggers @> '[{"type":"inbound_webhook"}]'`;
    //    matching the exact secret happens in JS to avoid string-encoding
    //    pitfalls inside the JSONB literal.
    const lookup = await this.client
      .from(WorkflowTriggersService.TABLE)
      .select(
        'id, workflow_id, triggers, workflows!inner(id, organization_id, is_archived, is_active, is_draft, created_by)',
      )
      .filter('triggers', 'cs', JSON.stringify([{ type: 'inbound_webhook' }]));

    if (lookup.error) throw new BadRequestException(lookup.error.message);

    const rows = (lookup.data ?? []) as ITransitionRow[];
    const match = this.findMatchingTrigger(rows, secret);

    if (!match) {
      throw new NotFoundException(
        'No active trigger configured for this secret',
      );
    }

    const { row, cfg } = match;
    const workflow = this.unwrapWorkflow(row);

    if (!workflow) {
      throw new NotFoundException(
        'No active trigger configured for this secret',
      );
    }

    // 3) Refuse archived / inactive workflows. Use 410 Gone so callers
    //    can distinguish "config gone" from "wrong secret".
    if (workflow.is_archived || workflow.is_active === false) {
      throw new GoneException(
        "Trigger's workflow is archived or no longer active",
      );
    }

    // 4) Optional HMAC verification. `cfg.secret` MUST equal `secret` at
    //    this point (findMatchingTrigger enforces it); use it as the HMAC
    //    key so callers can sign with the same shared secret.
    if (cfg.require_signature) {
      this.verifySignature(cfg.secret as string, payload, signature);
    }

    // 5) Engine availability gate — Phase B may not be wired yet.
    if (!this.engine) {
      throw new ServiceUnavailableException('Engine runtime not available');
    }

    // 6) Resolve the targeted task id. v1 contract: the trigger config may
    //    pin a task_id, otherwise the payload must carry one.
    const taskId = (cfg.task_id ?? payload.task_id) as string | undefined;

    if (!taskId || typeof taskId !== 'string') {
      throw new BadRequestException('payload.task_id required');
    }

    // 7) Synthesize the calling user. Prefer the trigger's `fire_as_user_id`
    //    so the audit log attributes the action to an explicit identity;
    //    fall back to the workflow's `created_by` as a system fallback.
    const firedAs = cfg.fire_as_user_id ?? workflow.created_by ?? null;

    if (!firedAs) {
      throw new BadRequestException(
        'Trigger has no fire_as_user_id and workflow has no created_by — cannot resolve identity',
      );
    }

    const user = await this.resolveRequestUser(
      firedAs,
      workflow.organization_id,
    );

    // 8) Fresh execution id — used both as the engine idempotency key and
    //    as the value returned to the caller for downstream correlation.
    const executionId = randomUUID();

    await this.engine.executeTransition({
      taskId,
      transitionId: row.id,
      // Inbound webhook payload is trigger metadata, not transition-screen
      // input. Passing it through as screen_input lets arbitrary external
      // keys land in tasks.custom_field_values on transitions without a
      // screen_field_group_id.
      screenInput: payload,
      user,
      executionId,
    });

    return { accepted: true, execution_id: executionId };
  }

  /**
   * Narrow the JSONB-containment hits to the exact inbound key. Older rules
   * stored a shared `secret`; the editor now surfaces a user-facing `slug`
   * and keeps `secret` optional. Match either so UI-created triggers are
   * reachable without breaking pre-existing secret-based integrations.
   */
  private findMatchingTrigger(
    rows: ITransitionRow[],
    secret: string,
  ): { row: ITransitionRow; cfg: ITriggerCfg } | null {
    let inactiveMatch: { row: ITransitionRow; cfg: ITriggerCfg } | null = null;

    for (const row of rows) {
      const triggers = Array.isArray(row.triggers) ? row.triggers : [];

      for (const trig of triggers) {
        const cfg = normalizeRuleConfig(trig) as ITriggerCfg;

        if (cfg?.type !== 'inbound_webhook') continue;

        const sharedSecret = typeof cfg.secret === 'string' ? cfg.secret : null;
        const slug = typeof cfg.slug === 'string' ? cfg.slug : null;

        if (sharedSecret !== secret && slug !== secret) continue;

        const workflow = this.unwrapWorkflow(row);
        const isRuntimeWorkflow =
          workflow &&
          !workflow.is_archived &&
          workflow.is_active !== false &&
          workflow.is_draft !== true;

        if (isRuntimeWorkflow) return { row, cfg };
        inactiveMatch ??= { row, cfg };
      }
    }

    return inactiveMatch;
  }

  /**
   * Supabase typings infer joined rows as either an object or an array
   * depending on FK cardinality; the runtime returns the embedded shape
   * either way. Collapse to a single object.
   */
  private unwrapWorkflow(row: ITransitionRow): {
    id: string;
    organization_id: string;
    is_archived: boolean | null;
    is_active: boolean | null;
    is_draft?: boolean | null;
    created_by: string | null;
  } | null {
    if (!row.workflows) return null;

    return Array.isArray(row.workflows)
      ? (row.workflows[0] ?? null)
      : row.workflows;
  }

  /**
   * Verify an HMAC-SHA256 signature over the JSON-stringified payload.
   * Accepts both the bare hex digest and the `sha256=<hex>` prefix that
   * GitHub-style webhooks emit. Uses timingSafeEqual to avoid leaking
   * comparison timing through the response latency.
   */
  private verifySignature(
    key: string,
    payload: Record<string, unknown>,
    signature: string | undefined,
  ): void {
    if (!signature) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }
    const provided = signature.startsWith('sha256=')
      ? signature.slice('sha256='.length)
      : signature;
    const expected = createHmac('sha256', key)
      .update(JSON.stringify(payload))
      .digest('hex');

    // timingSafeEqual requires equal-length buffers; mismatched length is
    // also an invalid signature, so short-circuit on length first.
    if (provided.length !== expected.length) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');

    if (!timingSafeEqual(a, b)) {
      throw new UnauthorizedException('Invalid HMAC signature');
    }
  }

  /**
   * Build the {@link RequestUser} shape the engine expects from the
   * resolved `public.users.id`. Falls back to a minimal stub when the
   * row cannot be loaded — the trigger still fired as a "system" identity
   * with the workflow's organization scope so RLS-respecting downstream
   * work has something to authorize against.
   */
  private async resolveRequestUser(
    userId: string,
    organizationId: string,
  ): Promise<RequestUser> {
    // Multi-tenant: organization_id was dropped from public.users. The
    // organizationId comes from the workflow row's organization_id (already
    // resolved by the caller), so we only need the user's email, role, and
    // is_active fields here.
    const r = await this.client
      .from('users')
      .select('id, email, role, is_active')
      .eq('id', userId)
      .maybeSingle();

    const data = r.data as IUserRow | null;
    const email = data?.email ?? 'workflow-trigger@system.local';
    const role = data?.role ?? null;
    const isActive = data?.is_active ?? true;

    return {
      authUserId: userId,
      userId,
      email,
      organizationId,
      memberships: [],
      role,
      isActive,
      appMetadata: { fired_by: 'workflow_trigger_inbound' },
    };
  }
}
