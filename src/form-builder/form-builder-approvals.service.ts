import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { NotificationsBroadcastService } from '../notifications/notifications-broadcast.service';
import { MailService } from '../mail/mail.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { evaluateRuleGroup, RuleGroup } from './logic/condition-evaluator';
import type { DecideApprovalDto } from './dto/decide-approval.dto';

// entity_type ("category") for every approval row written to the shared audit_logs table.
const APPROVAL_AUDIT_ENTITY = 'form_approval';

const APPROVALS_TABLE = 'form_builder_approvals';
const STEPS_TABLE = 'form_builder_approval_steps';
const FORMS_TABLE = 'form_builder';
const SUBMISSIONS_TABLE = 'form_builder_submissions';

// Emitted when the final approval layer approves. The submission-events service listens and creates
// the task that was deferred at submit time. Defined here (with the emitter) so the listener imports
// it without a circular dependency (events-service already imports from this file).
export const FORM_APPROVAL_COMPLETED_EVENT = 'form_builder.approval.completed';

export interface ApprovalCompletedEvent {
  submissionId: string;
}

// approval config lives under form.settings.approval (settings jsonb is .passthrough(),
// so no migration is needed to store it).
export interface ApprovalLayer {
  id: string;
  label: string;
  approverUserIds: string[];
  requireAll: boolean;
  // Quorum: minimum approvers in this layer who must approve ("X of N"). When set it wins over
  // requireAll. Clamped to the layer's actual approver count at runtime.
  minApprovals?: number;
  // Per-layer overrides (fall back to the form-level flag / no message when undefined).
  requireCommentOnReject?: boolean;
  message?: string;
}

export interface ApprovalConfig {
  enabled?: boolean;
  // Multi-layer config (takes precedence over legacy fields when present).
  layers?: ApprovalLayer[];
  // Legacy flat config.
  mode?: 'sequential' | 'parallel';
  approverUserIds?: string[];
  condition?: RuleGroup | null;
  requireCommentOnReject?: boolean;
}

// the minimal submission shape the dispatch/approval path needs.
export interface SubmissionForApproval {
  id: string;
  form_id: string;
  space_id: string;
  organization_id: string;
  submitted_by: string | null;
  data: Record<string, unknown> | null;
  is_test?: boolean | null;
}

interface ApprovalRow {
  id: string;
  form_id: string;
  space_id: string;
  organization_id: string;
  submission_id: string;
  status: string;
  mode: string;
}

interface StepRow {
  id: string;
  approval_id: string;
  approver_user_id: string;
  step_order: number;
  layer_index: number;
  layer_require_all: boolean;
  layer_min_approvals: number | null;
  decision: string;
}

interface Ctx {
  spaceId: string;
  orgId: string;
}

type ApproverRef = { userId: string; stepId?: string };

// Internal, Jotform-style approval routing. A submission that requires approval spawns one
// form_builder_approvals row (unique per submission => startApproval is idempotent) and one
// form_builder_approval_steps row per approver (snapshotted from settings.approval at start
// time). The backend uses the service-role client (RLS bypassed), so every query is scoped
// by organization_id + space_id in app code.
@Injectable()
export class FormBuilderApprovalsService {
  private readonly logger = new Logger(FormBuilderApprovalsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly broadcast: NotificationsBroadcastService,
    private readonly mail: MailService,
    private readonly events: EventEmitter2,
    // Optional so the manually-constructed unit spec (and any wiring gap) degrades to
    // no-op audit logging instead of a constructor break. Always present in the app.
    @Optional() private readonly audit?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // Best-effort append to the shared audit_logs table (entity_type='form_approval'). Fire-and-forget:
  // logAction/logSystemAction swallow their own errors, and we never await, so a slow or failed audit
  // write can never delay or break an approval decision. `actorUserId` null => a system row ("System").
  private recordApprovalAudit(
    ctx: Ctx,
    actorUserId: string | null,
    formId: string,
    action:
      | 'form.approval.submitted'
      | 'form.approval.approved'
      | 'form.approval.rejected'
      | 'form.approval.auto_cancelled'
      | 'form.approval.finalized',
    changes: Record<string, unknown>,
  ): void {
    if (!this.audit) return;

    if (actorUserId) {
      void this.audit.logAction(
        ctx.orgId,
        actorUserId,
        APPROVAL_AUDIT_ENTITY,
        formId,
        action,
        changes,
      );
    } else {
      void this.audit.logSystemAction(
        ctx.orgId,
        APPROVAL_AUDIT_ENTITY,
        formId,
        action,
        changes,
      );
    }
  }

  // Called (best-effort) from the shared submission-events dispatch. Reads the form's
  // approval config, evaluates the optional condition, snapshots the approvers into steps,
  // and notifies the first step/layer. Never throws into the submit path.
  async startApproval(
    submission: SubmissionForApproval,
    ctx: Ctx,
  ): Promise<boolean> {
    try {
      const config = await this.loadConfig(submission.form_id, ctx);

      if (!config?.enabled) return false;

      // optional condition — evaluated against the submission answers.
      if (
        config.condition &&
        !evaluateRuleGroup(config.condition, submission.data ?? {})
      )
        return false;

      if (config.layers?.length) {
        await this.startLayeredApproval(submission, config, ctx);
      } else {
        await this.startFlatApproval(submission, config, ctx);
      }

      // Returns true only when a real pending approval with at least one pending step now exists,
      // so downstream finalize (task creation) is gated. A misconfigured/empty approval returns
      // false and must NOT block the submission's task.
      const created = await this.hasPendingApprovalWithSteps(
        submission.id,
        ctx,
      );

      // Audit: open the approval-history timeline for this submission (only when steps were actually
      // created). System-authored (triggered by the submission dispatch, not an interactive user).
      if (created) {
        this.recordApprovalAudit(
          ctx,
          null,
          submission.form_id,
          'form.approval.submitted',
          {
            submission_id: submission.id,
            submitted_by: submission.submitted_by ?? null,
          },
        );
      }

      return created;
    } catch (err) {
      this.logger.warn(
        `startApproval failed for submission ${submission.id}: ${
          (err as Error)?.message ?? err
        }`,
      );

      return false;
    }
  }

  private async hasPendingApprovalWithSteps(
    submissionId: string,
    ctx: Ctx,
  ): Promise<boolean> {
    const { data } = await this.client
      .from(APPROVALS_TABLE)
      .select('id, steps:form_builder_approval_steps(id)')
      .eq('submission_id', submissionId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('status', 'pending')
      .maybeSingle();

    const steps = (data as { steps?: unknown[] } | null)?.steps ?? [];

    return steps.length > 0;
  }

  // ── Multi-layer approval ────────────────────────────────────────────────────

  private async startLayeredApproval(
    submission: SubmissionForApproval,
    config: ApprovalConfig,
    ctx: Ctx,
  ): Promise<void> {
    const layers = config.layers!;

    // Build step rows for every layer up front. Skip layers that have no active members.
    const allStepRows: Array<{
      organization_id: string;
      space_id: string;
      approval_id?: string; // filled after approval row insert
      approver_user_id: string;
      step_order: number;
      layer_index: number;
      layer_require_all: boolean;
      layer_min_approvals: number;
    }> = [];

    for (let layerIdx = 0; layerIdx < layers.length; layerIdx++) {
      const layer = layers[layerIdx];
      const rawIds = Array.from(
        new Set((layer.approverUserIds ?? []).filter(Boolean)),
      );

      if (!rawIds.length) {
        this.logger.warn(
          `startLayeredApproval: layer ${layerIdx} has no configured approvers for form ${submission.form_id}`,
        );

        continue;
      }

      const members = await this.filterToSpaceMembers(ctx.spaceId, rawIds);

      if (!members.length) {
        this.logger.warn(
          `startLayeredApproval: layer ${layerIdx} has no active space members for form ${submission.form_id}, skipping`,
        );

        continue;
      }

      // Effective quorum for this layer ("X of N"), clamped to the real member count.
      const layerMin = Math.min(
        Math.max(
          1,
          layer.minApprovals ?? (layer.requireAll ? members.length : 1),
        ),
        members.length,
      );

      members.forEach((uid, pos) => {
        allStepRows.push({
          organization_id: ctx.orgId,
          space_id: ctx.spaceId,
          approver_user_id: uid,
          step_order: layerIdx * 1000 + pos,
          layer_index: layerIdx,
          layer_require_all: layer.requireAll,
          layer_min_approvals: layerMin,
        });
      });
    }

    if (!allStepRows.length) {
      this.logger.warn(
        `startLayeredApproval: no valid approvers across any layer for form ${submission.form_id}`,
      );

      return;
    }

    // Create the approval row. mode='sequential' for layered (layer-to-layer is sequential).
    const { data: approvalRow, error: apprErr } = await this.client
      .from(APPROVALS_TABLE)
      .insert({
        organization_id: ctx.orgId,
        space_id: ctx.spaceId,
        form_id: submission.form_id,
        submission_id: submission.id,
        status: 'pending',
        mode: 'sequential',
      })
      .select('id')
      .single();

    if (apprErr) {
      if (apprErr.code === '23505') return; // already started (idempotent)

      throw new BadRequestException(apprErr.message);
    }

    const approvalId = (approvalRow as { id: string }).id;

    // Insert all steps (all layers) at once.
    const rowsWithApproval = allStepRows.map((r) => ({
      ...r,
      approval_id: approvalId,
    }));

    const { data: insertedSteps, error: stepErr } = await this.client
      .from(STEPS_TABLE)
      .insert(rowsWithApproval)
      .select('id, approver_user_id, layer_index');

    if (stepErr) throw new BadRequestException(stepErr.message);

    // Notify the first non-empty layer.
    const inserted = (
      insertedSteps as Array<{
        id: string;
        approver_user_id: string;
        layer_index: number;
      }>
    ).sort((a, b) => a.layer_index - b.layer_index);

    const firstLayerIndex = inserted[0]?.layer_index ?? 0;
    const firstLayerRefs: ApproverRef[] = inserted
      .filter((s) => s.layer_index === firstLayerIndex)
      .map((s) => ({ userId: s.approver_user_id, stepId: s.id }));

    const firstLayer = config.layers?.[firstLayerIndex];

    await this.notifyApprovers(
      firstLayerRefs,
      submission.form_id,
      submission.id,
      ctx,
      {
        message: firstLayer?.message,
        requireCommentOnReject:
          firstLayer?.requireCommentOnReject ?? config.requireCommentOnReject,
      },
    );
  }

  //Legacy flat approval
  private async startFlatApproval(
    submission: SubmissionForApproval,
    config: ApprovalConfig,
    ctx: Ctx,
  ): Promise<void> {
    const approverIds = Array.from(
      new Set((config.approverUserIds ?? []).filter(Boolean)),
    );

    if (!approverIds.length) return;

    const members = await this.filterToSpaceMembers(ctx.spaceId, approverIds);

    if (!members.length) {
      this.logger.warn(
        `startFlatApproval: no current space members among configured approvers for form ${submission.form_id}`,
      );

      return;
    }

    const mode = config.mode === 'parallel' ? 'parallel' : 'sequential';

    // one approval per submission — the unique index makes this idempotent.
    const { data: approvalRow, error: apprErr } = await this.client
      .from(APPROVALS_TABLE)
      .insert({
        organization_id: ctx.orgId,
        space_id: ctx.spaceId,
        form_id: submission.form_id,
        submission_id: submission.id,
        status: 'pending',
        mode,
      })
      .select('id')
      .single();

    if (apprErr) {
      if (apprErr.code === '23505') return;

      throw new BadRequestException(apprErr.message);
    }

    const approvalId = (approvalRow as { id: string }).id;

    const stepRows = members.map((uid, idx) => ({
      organization_id: ctx.orgId,
      space_id: ctx.spaceId,
      approval_id: approvalId,
      approver_user_id: uid,
      step_order: idx,
      // layer_index defaults to 0, layer_require_all defaults to true — fine for flat mode
    }));

    const { data: insertedSteps, error: stepErr } = await this.client
      .from(STEPS_TABLE)
      .insert(stepRows)
      .select('id, approver_user_id');

    if (stepErr) throw new BadRequestException(stepErr.message);

    const inserted = insertedSteps as Array<{
      id: string;
      approver_user_id: string;
    }>;

    // sequential → notify only the first approver; parallel → notify everyone.
    const toNotify: ApproverRef[] =
      mode === 'parallel'
        ? inserted.map((s) => ({ userId: s.approver_user_id, stepId: s.id }))
        : [{ userId: inserted[0].approver_user_id, stepId: inserted[0].id }];

    await this.notifyApprovers(
      toNotify,
      submission.form_id,
      submission.id,
      ctx,
    );
  }

  // ── Decide ─────────────────────────────────────────────────────────────────

  // An approver's verdict on one step. Row-level authorization: 404 unless a PENDING step
  // with this id is assigned to the caller.
  async decide(
    stepId: string,
    userId: string,
    dto: DecideApprovalDto,
    ctx: Ctx,
  ) {
    const { data: stepData, error: stepErr } = await this.client
      .from(STEPS_TABLE)
      .select(
        'id, approval_id, approver_user_id, step_order, layer_index, layer_require_all, layer_min_approvals, decision',
      )
      .eq('id', stepId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('approver_user_id', userId)
      .eq('decision', 'pending')
      .maybeSingle();

    if (stepErr) throw new BadRequestException(stepErr.message);
    if (!stepData) throw new NotFoundException('Approval step not found');

    const step = stepData as StepRow;

    // Cross-layer gating: a step is actionable only when its layer is the ACTIVE layer (the lowest
    // layer_index still pending for this approval). This blocks approving a later layer before earlier
    // layers finish — which would otherwise let advanceLayered finalize the whole approval out of order.
    // Fail-open on a lookup error/empty so a transient DB issue can never block a legitimate decision.
    const { data: pendingLayerRows, error: pendingLayerErr } = await this.client
      .from(STEPS_TABLE)
      .select('layer_index')
      .eq('approval_id', step.approval_id)
      .eq('organization_id', ctx.orgId)
      .eq('decision', 'pending');

    if (!pendingLayerErr && pendingLayerRows?.length) {
      const activeLayer = Math.min(
        ...pendingLayerRows.map(
          (r) => (r as { layer_index: number | null }).layer_index ?? 0,
        ),
      );

      if ((step.layer_index ?? 0) !== activeLayer)
        throw new BadRequestException(
          'An earlier approval layer is still pending — this step becomes available once the previous layer is approved.',
        );
    }

    const approval = await this.getApproval(step.approval_id, ctx);

    if (approval.status !== 'pending')
      throw new BadRequestException('This approval is already resolved');

    const config = await this.loadConfig(approval.form_id, ctx);

    // A rejection ALWAYS requires a reason (the per-layer/global requireCommentOnReject flag can only
    // make it stricter, never looser). Approvals may still be comment-free.
    if (dto.decision === 'rejected' && !dto.comment?.trim())
      throw new BadRequestException('A comment is required to reject');

    const nowIso = new Date().toISOString();

    const { error: updErr } = await this.client
      .from(STEPS_TABLE)
      .update({
        decision: dto.decision,
        comment: dto.comment ?? null,
        decided_at: nowIso,
      })
      .eq('id', step.id);

    if (updErr) throw new BadRequestException(updErr.message);

    // Audit: record this approver's own verdict (with the reason) to the history log.
    this.recordApprovalAudit(
      ctx,
      userId,
      approval.form_id,
      dto.decision === 'approved'
        ? 'form.approval.approved'
        : 'form.approval.rejected',
      {
        approval_id: approval.id,
        submission_id: approval.submission_id,
        step_id: step.id,
        layer_index: step.layer_index,
        decision: dto.decision,
        reason: dto.comment?.trim() || null,
        approver_user_id: userId,
      },
    );

    // Reflect this approver's own verdict on their bell notification so the inline Approve/Reject
    // buttons become a resolved status chip. Best-effort — never fails the approval decision.
    await this.resolveApproverNotification(
      userId,
      step.id,
      dto.decision === 'approved' ? 'accepted' : 'declined',
      ctx,
    );

    const isLayered = (config?.layers?.length ?? 0) > 0;

    // Layered: both approve and reject are quorum-aware — a single reject only fails the whole
    // approval when its layer can no longer reach the required minimum.
    if (isLayered) {
      return this.advanceLayered(step, approval, ctx, nowIso, dto.decision);
    }

    // Flat/legacy: any reject is terminal.
    if (dto.decision === 'rejected') {
      await this.finalizeApproval(approval, 'rejected', ctx);

      return { status: 'rejected' as const };
    }

    return this.advanceFlat(step, approval, ctx);
  }

  // Layered advance — quorum-aware ("X of N" per layer). Handles both approve and reject.
  // The caller has already written this step's decision, so counts below include it.
  private async advanceLayered(
    step: StepRow,
    approval: ApprovalRow,
    ctx: Ctx,
    nowIso: string,
    decision: 'approved' | 'rejected',
  ) {
    const layerIndex = step.layer_index;

    // Load every step in this layer to evaluate the quorum.
    const { data: layerData, error: lErr } = await this.client
      .from(STEPS_TABLE)
      .select('id, decision')
      .eq('approval_id', approval.id)
      .eq('layer_index', layerIndex);

    if (lErr) throw new BadRequestException(lErr.message);

    const layerSteps = (layerData ?? []) as Array<{
      id: string;
      decision: string;
    }>;
    const total = layerSteps.length;
    const approvedCount = layerSteps.filter(
      (s) => s.decision === 'approved',
    ).length;
    const pendingCount = layerSteps.filter(
      (s) => s.decision === 'pending',
    ).length;

    // Effective minimum, clamped to the layer's real approver count.
    const min = Math.min(
      Math.max(
        1,
        step.layer_min_approvals ?? (step.layer_require_all ? total : 1),
      ),
      Math.max(1, total),
    );

    if (decision === 'rejected') {
      // Can the layer still reach its minimum with the remaining approvers?
      if (approvedCount + pendingCount >= min) {
        return { status: 'pending' as const };
      }

      // Minimum is now unreachable → the whole approval is rejected.
      await this.finalizeApproval(approval, 'rejected', ctx);

      return { status: 'rejected' as const };
    }

    // Approved but quorum not yet met → keep waiting on this layer.
    if (approvedCount < min) {
      return { status: 'pending' as const };
    }

    // Quorum met — cancel this layer's remaining pending steps, then advance.
    const { data: cancelledSteps } = await this.client
      .from(STEPS_TABLE)
      .update({
        decision: 'rejected',
        comment: 'Auto-cancelled: layer approval threshold met',
        decided_at: nowIso,
      })
      .eq('approval_id', approval.id)
      .eq('layer_index', layerIndex)
      .eq('decision', 'pending')
      .select('id');

    const cancelledIds = (
      (cancelledSteps as Array<{ id: string }> | null) ?? []
    ).map((s) => s.id);

    // Audit: record the quorum auto-cancel as its own action so history never confuses a
    // system-voided peer step with a genuine rejection. Only when a peer was actually cancelled.
    if (cancelledIds.length > 0) {
      this.recordApprovalAudit(
        ctx,
        null,
        approval.form_id,
        'form.approval.auto_cancelled',
        {
          approval_id: approval.id,
          submission_id: approval.submission_id,
          layer_index: layerIndex,
          cancelled_step_ids: cancelledIds,
          reason: 'Layer approval threshold met',
        },
      );
    }

    // Those approvers' votes are no longer needed — drop their now-stale inline buttons.
    await this.dismissStepRequestNotifications(cancelledIds, ctx);

    // Find the next non-empty layer.
    const { data: remainingData, error: remErr } = await this.client
      .from(STEPS_TABLE)
      .select('id, approver_user_id, layer_index')
      .eq('approval_id', approval.id)
      .eq('decision', 'pending')
      .gt('layer_index', layerIndex)
      .order('layer_index', { ascending: true });

    if (remErr) throw new BadRequestException(remErr.message);

    const remaining =
      (remainingData as Array<{
        id: string;
        approver_user_id: string;
        layer_index: number;
      }>) ?? [];

    if (!remaining.length) {
      // All layers complete.
      await this.finalizeApproval(approval, 'approved', ctx);

      return { status: 'approved' as const };
    }

    // Notify all approvers in the next layer (lowest remaining layer_index).
    const nextLayerIndex = remaining[0].layer_index;
    const nextLayerRefs: ApproverRef[] = remaining
      .filter((s) => s.layer_index === nextLayerIndex)
      .map((s) => ({ userId: s.approver_user_id, stepId: s.id }));

    const nextCfg = await this.loadConfig(approval.form_id, ctx);
    const nextLayer = nextCfg?.layers?.[nextLayerIndex];

    await this.notifyApprovers(
      nextLayerRefs,
      approval.form_id,
      approval.submission_id,
      ctx,
      {
        message: nextLayer?.message,
        requireCommentOnReject:
          nextLayer?.requireCommentOnReject ?? nextCfg?.requireCommentOnReject,
      },
    );

    return { status: 'pending' as const };
  }

  // ── Legacy flat advance ─────────────────────────────────────────────────────

  private async advanceFlat(step: StepRow, approval: ApprovalRow, ctx: Ctx) {
    const { data: pendingData, error: pendErr } = await this.client
      .from(STEPS_TABLE)
      .select('id, approver_user_id, step_order')
      .eq('approval_id', approval.id)
      .eq('decision', 'pending')
      .order('step_order', { ascending: true });

    if (pendErr) throw new BadRequestException(pendErr.message);

    const pending = (pendingData ?? []) as Array<{
      id: string;
      approver_user_id: string;
      step_order: number;
    }>;

    if (!pending.length) {
      await this.finalizeApproval(approval, 'approved', ctx);

      return { status: 'approved' as const };
    }

    // sequential → advance to next pending approver; parallel → wait for others.
    if (approval.mode !== 'parallel') {
      const next = pending[0];

      await this.notifyApprovers(
        [{ userId: next.approver_user_id, stepId: next.id }],
        approval.form_id,
        approval.submission_id,
        ctx,
      );
    }

    return { status: 'pending' as const };
  }

  // Manager / inbox queries
  // Manager view — all approvals for a form with their steps + approver names.
  async listForForm(formId: string, ctx: Ctx) {
    await this.assertForm(formId, ctx);

    const { data, error } = await this.client
      .from(APPROVALS_TABLE)
      .select(
        '*, steps:form_builder_approval_steps(*, approver:users!approver_user_id(id, first_name, last_name, email))',
      )
      .eq('form_id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    return data ?? [];
  }

  // Approval History — the durable, append-only timeline for a form, read from the shared audit_logs
  // table (entity_type='form_approval', entity_id=form_id). Org-scoped; space is enforced via
  // assertForm (a form is space-unique and audit_logs has no space_id). Guarded by view_form_responses
  // at the controller, matching listForForm.
  async listApprovalHistory(formId: string, ctx: Ctx) {
    await this.assertForm(formId, ctx);

    const { data, error } = await this.client
      .from('audit_logs')
      .select(
        'id, action, changes, created_at, user_id, actor:users!audit_logs_user_id_fkey(id, first_name, last_name, email)',
      )
      .eq('organization_id', ctx.orgId)
      .eq('entity_type', APPROVAL_AUDIT_ENTITY)
      .eq('entity_id', formId)
      .order('created_at', { ascending: false });

    if (error) throw new BadRequestException(error.message);

    return data ?? [];
  }

  // Inbox — pending steps assigned to the caller, only for still-pending approvals.
  async listPendingForApprover(spaceId: string, orgId: string, userId: string) {
    const { data, error } = await this.client
      .from(STEPS_TABLE)
      .select(
        '*, approval:form_builder_approvals!approval_id(id, form_id, submission_id, status, mode, created_at, form:form_builder!form_id(id, name, icon))',
      )
      .eq('space_id', spaceId)
      .eq('organization_id', orgId)
      .eq('approver_user_id', userId)
      .eq('decision', 'pending')
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as Array<
      Record<string, unknown> & {
        approval_id?: string;
        layer_index?: number | null;
        approval?: { status?: string } | null;
      }
    >;

    // keep only steps whose approval is still pending (a rejected chain leaves sibling steps pending,
    // but they must not appear as actionable in the inbox).
    const pendingRows = rows.filter((r) => r.approval?.status === 'pending');

    // Cross-layer gating: surface only steps in each approval's ACTIVE (lowest pending) layer, so a
    // later layer never appears in the inbox before earlier layers are approved.
    const activeLayer = await this.activePendingLayers(
      pendingRows.map((r) => r.approval_id ?? '').filter(Boolean),
      orgId,
    );

    return pendingRows.filter((r) => {
      const active = activeLayer[r.approval_id ?? ''];

      return active === undefined || (r.layer_index ?? 0) === active;
    });
  }

  // Org-wide inbox — every pending step assigned to the caller across ALL spaces in their
  // org (backs the profile-menu "Approvals" page). Scoped to the caller's own steps
  // (approver_user_id) + their org, so it stays tenant-safe even with the service-role
  // client. Each row carries its own space_id so the caller can decide per step.
  async listPendingForApproverOrgWide(orgId: string, userId: string) {
    const { data, error } = await this.client
      .from(STEPS_TABLE)
      .select(
        '*, approval:form_builder_approvals!approval_id(id, form_id, submission_id, status, mode, created_at, form:form_builder!form_id(id, name, icon))',
      )
      .eq('organization_id', orgId)
      .eq('approver_user_id', userId)
      .eq('decision', 'pending')
      .order('created_at', { ascending: true });

    if (error) throw new BadRequestException(error.message);

    const rows = (data ?? []) as Array<
      Record<string, unknown> & {
        approval_id?: string;
        layer_index?: number | null;
        approval?: { status?: string } | null;
      }
    >;

    // keep only steps whose approval is still pending (a rejected chain leaves sibling steps pending,
    // but they must not appear as actionable in the inbox).
    const pendingRows = rows.filter((r) => r.approval?.status === 'pending');

    // Cross-layer gating: surface only steps in each approval's ACTIVE (lowest pending) layer.
    const activeLayer = await this.activePendingLayers(
      pendingRows.map((r) => r.approval_id ?? '').filter(Boolean),
      orgId,
    );

    return pendingRows.filter((r) => {
      const active = activeLayer[r.approval_id ?? ''];

      return active === undefined || (r.layer_index ?? 0) === active;
    });
  }

  // Org-wide approval HISTORY — every step the caller has already decided (approved/rejected)
  // across ALL spaces in their org, newest first. Same tenant safety as the pending inbox
  // (approver_user_id + organization_id keep it safe under the RLS-bypassing service-role client);
  // each row carries its own space_id. Unlike the inbox it does NOT drop rows whose envelope later
  // resolved, nor gate by active layer — history must show my past decisions regardless. Capped.
  async listDecidedForApproverOrgWide(orgId: string, userId: string) {
    const { data, error } = await this.client
      .from(STEPS_TABLE)
      .select(
        '*, approval:form_builder_approvals!approval_id(id, form_id, submission_id, status, mode, created_at, form:form_builder!form_id(id, name, icon))',
      )
      .eq('organization_id', orgId)
      .eq('approver_user_id', userId)
      .in('decision', ['approved', 'rejected'])
      .order('decided_at', { ascending: false })
      .limit(200);

    if (error) throw new BadRequestException(error.message);

    return (data ?? []) as Array<Record<string, unknown>>;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  // Returns the ACTIVE (lowest still-pending) layer_index per approval id, used to gate the inbox so
  // only the current layer's steps are shown. Best-effort — on error returns {} so callers fail-open.
  private async activePendingLayers(
    approvalIds: string[],
    orgId: string,
  ): Promise<Record<string, number>> {
    const ids = Array.from(new Set(approvalIds.filter(Boolean)));

    if (!ids.length) return {};

    const { data, error } = await this.client
      .from(STEPS_TABLE)
      .select('approval_id, layer_index')
      .in('approval_id', ids)
      .eq('organization_id', orgId)
      .eq('decision', 'pending');

    if (error) {
      this.logger.warn(`activePendingLayers failed: ${error.message}`);

      return {};
    }

    const min: Record<string, number> = {};

    for (const row of (data ?? []) as Array<{
      approval_id: string;
      layer_index: number | null;
    }>) {
      const li = row.layer_index ?? 0;

      if (min[row.approval_id] === undefined || li < min[row.approval_id])
        min[row.approval_id] = li;
    }

    return min;
  }

  private async finalizeApproval(
    approval: ApprovalRow,
    status: 'approved' | 'rejected',
    ctx: Ctx,
  ): Promise<void> {
    const { data: transitioned, error } = await this.client
      .from(APPROVALS_TABLE)
      .update({ status, decided_at: new Date().toISOString() })
      .eq('id', approval.id)
      .eq('status', 'pending')
      .select('id');

    if (error) throw new BadRequestException(error.message);

    // Did THIS call actually flip the row? The eq('status','pending') guard above makes a
    // duplicate/late finalize match zero rows, so this is the single source of truth for
    // "I am the caller that resolved this approval". Everything with a side effect that must
    // happen exactly once hangs off it.
    const didTransition =
      ((transitioned as Array<{ id: string }> | null)?.length ?? 0) > 0;

    // Audit the envelope outcome — but ONLY when this call actually flipped the row.
    // finalizeApproval is reachable from several call sites, so this prevents double-logging.
    if (didTransition) {
      this.recordApprovalAudit(
        ctx,
        null,
        approval.form_id,
        'form.approval.finalized',
        {
          approval_id: approval.id,
          submission_id: approval.submission_id,
          status,
        },
      );
    }

    // The approval is resolved — any request notifications still pending for its steps are no longer
    // actionable, so dismiss them ("No longer needed" chip) instead of leaving dead Approve/Reject
    // buttons. The acting approver's own row was already resolved in decide(), so it's skipped here.
    const { data: approvalSteps } = await this.client
      .from(STEPS_TABLE)
      .select('id')
      .eq('approval_id', approval.id);

    await this.dismissStepRequestNotifications(
      ((approvalSteps as Array<{ id: string }> | null) ?? []).map((s) => s.id),
      ctx,
    );

    // On final approval, let the submission-events service create the task that was deferred at
    // submit time.
    //
    // Gated on `didTransition` for the same reason as the audit above, and it matters more here:
    // the listener's "already has a task" check is a read-then-write with no lock, and
    // idx_form_builder_submissions_task_id is NOT unique — so two concurrent finalizes both
    // emitting would let both listeners pass the check and create DUPLICATE tasks for one
    // submission. Only the caller that actually flipped pending -> approved may emit.
    if (didTransition && status === 'approved') {
      this.events.emit(FORM_APPROVAL_COMPLETED_EVENT, {
        submissionId: approval.submission_id,
      } satisfies ApprovalCompletedEvent);
    }

    // A rejected envelope will NEVER create the deferred task (no completed event fires), so move the
    // submission's 'pending_approval' marker to a terminal state — otherwise the responses view would
    // show "awaiting approval" forever. Best-effort; scoped to this submission.
    //
    // Also gated on `didTransition`, and this one is not merely tidiness: an approve and a reject
    // can race (one approver meets quorum while another rejects into an unreachable layer). Both
    // reach finalizeApproval, only one flips the row. If the losing call were the rejecting one, it
    // would stamp "Approval was rejected — no task created" onto a submission that was actually
    // APPROVED and whose task has already been created — a permanently contradictory record.
    if (didTransition && status === 'rejected') {
      const { error: outcomeErr } = await this.client
        .from(SUBMISSIONS_TABLE)
        .update({
          task_creation_status: 'skipped',
          task_creation_detail: 'Approval was rejected — no task created',
        })
        .eq('id', approval.submission_id);

      if (outcomeErr) {
        this.logger.warn(
          `failed to record rejected-approval outcome for submission ${approval.submission_id}: ${outcomeErr.message}`,
        );
      }
    }

    // best-effort — notify the submitter of the outcome. Gated too: in an approve/reject race the
    // losing call would otherwise send a second, contradictory "your submission was rejected"
    // notification for an approval that resolved as approved.
    if (!didTransition) return;

    await this.notifySubmitter(approval, status, ctx).catch((err) =>
      this.logger.warn(
        `notifySubmitter failed for approval ${approval.id}: ${
          (err as Error)?.message ?? err
        }`,
      ),
    );
  }

  // Flip the acting approver's own request notification to a resolved status ('accepted'/'declined')
  // so the bell's inline buttons become a status chip. Best-effort — logs and swallows on error so a
  // notifications write can never fail the approval decision. Scoped by user + org + step_id.
  private async resolveApproverNotification(
    userId: string,
    stepId: string,
    status: 'accepted' | 'declined',
    ctx: Ctx,
  ): Promise<void> {
    try {
      const { error } = await this.client
        .from('notifications')
        .update({
          action_status: status,
          is_read: true,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId)
        .eq('organization_id', ctx.orgId)
        .eq('type', 'form_approval_request')
        .contains('metadata', { step_id: stepId });

      if (error)
        this.logger.warn(
          `resolveApproverNotification failed for step ${stepId}: ${error.message}`,
        );
    } catch (err) {
      this.logger.warn(
        `resolveApproverNotification threw for step ${stepId}: ${
          (err as Error)?.message ?? err
        }`,
      );
    }
  }

  // Dismiss still-pending request notifications for steps that are no longer actionable (auto-cancelled
  // when a layer's quorum is met, or abandoned when the approval is finalized). Renders the neutral
  // "No longer needed" chip instead of dead Approve/Reject buttons. Best-effort per step.
  private async dismissStepRequestNotifications(
    stepIds: string[],
    ctx: Ctx,
  ): Promise<void> {
    const ids = Array.from(new Set(stepIds.filter(Boolean)));

    if (!ids.length) return;

    const nowIso = new Date().toISOString();

    await Promise.all(
      ids.map(async (stepId) => {
        try {
          const { error } = await this.client
            .from('notifications')
            .update({
              action_status: 'dismissed',
              is_read: true,
              updated_at: nowIso,
            })
            .eq('organization_id', ctx.orgId)
            .eq('type', 'form_approval_request')
            .eq('action_status', 'pending')
            .contains('metadata', { step_id: stepId });

          if (error)
            this.logger.warn(
              `dismissStepRequestNotifications failed for step ${stepId}: ${error.message}`,
            );
        } catch (err) {
          this.logger.warn(
            `dismissStepRequestNotifications threw for step ${stepId}: ${
              (err as Error)?.message ?? err
            }`,
          );
        }
      }),
    );
  }

  private async getApproval(
    approvalId: string,
    ctx: Ctx,
  ): Promise<ApprovalRow> {
    const { data, error } = await this.client
      .from(APPROVALS_TABLE)
      .select(
        'id, form_id, space_id, organization_id, submission_id, status, mode',
      )
      .eq('id', approvalId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Approval not found');

    return data as ApprovalRow;
  }

  private async assertForm(formId: string, ctx: Ctx): Promise<void> {
    const { data, error } = await this.client
      .from(FORMS_TABLE)
      .select('id')
      .eq('id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);
    if (!data) throw new NotFoundException('Form not found');
  }

  private async loadConfig(
    formId: string,
    ctx: Ctx,
  ): Promise<ApprovalConfig | null> {
    const { data, error } = await this.client
      .from(FORMS_TABLE)
      .select('settings')
      .eq('id', formId)
      .eq('space_id', ctx.spaceId)
      .eq('organization_id', ctx.orgId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    const settings =
      (data as { settings?: Record<string, unknown> } | null)?.settings ?? {};

    return (settings.approval as ApprovalConfig | undefined) ?? null;
  }

  // Direct active user members of the space, intersected with the requested approver ids.
  private async filterToSpaceMembers(
    spaceId: string,
    userIds: string[],
  ): Promise<string[]> {
    if (!userIds.length) return [];

    const { data, error } = await this.client
      .from('space_members')
      .select('user_id')
      .eq('space_id', spaceId)
      .eq('is_active', true)
      .eq('member_type', 'user')
      .in('user_id', userIds);

    if (error) {
      this.logger.warn(`filterToSpaceMembers failed: ${error.message}`);

      // fail open to the configured list rather than silently dropping approvers
      return userIds;
    }

    const present = new Set(
      (data ?? []).map((r) => (r as { user_id: string }).user_id),
    );

    // preserve the configured order (drives sequential step_order within a layer)
    return userIds.filter((id) => present.has(id));
  }

  private async notifyApprovers(
    approvers: ApproverRef[],
    formId: string,
    submissionId: string | null,
    ctx: Ctx,
    layerOpts?: { message?: string; requireCommentOnReject?: boolean },
  ): Promise<void> {
    const layerMessage = layerOpts?.message?.trim();

    await this.notify(approvers, {
      orgId: ctx.orgId,
      spaceId: ctx.spaceId,
      formId,
      submissionId,
      type: 'form_approval_request',
      // actionable in the bell — inline Approve/Reject (mirrors the space-invitation lifecycle)
      actionStatus: 'pending',
      titleFor: (formName) => `Approval requested: "${formName}"`,
      bodyFor: (formName, link) =>
        `A submission of "${formName}" is waiting for your approval.` +
        (layerMessage ? `\n\n${layerMessage}` : '') +
        (link ? `\n\nReview it in the app: ${link}` : ''),
      linkKind: 'responses',
      // Surfaces to the bell's inline reject so it enforces the same comment rule as the backend.
      metadataExtra: layerOpts?.requireCommentOnReject
        ? { require_comment_on_reject: true }
        : undefined,
    }).catch((err) =>
      this.logger.warn(
        `notifyApprovers failed: ${(err as Error)?.message ?? err}`,
      ),
    );
  }

  private async notifySubmitter(
    approval: ApprovalRow,
    status: 'approved' | 'rejected',
    ctx: Ctx,
  ): Promise<void> {
    const { data, error } = await this.client
      .from(SUBMISSIONS_TABLE)
      .select('submitted_by')
      .eq('id', approval.submission_id)
      .maybeSingle();

    if (error) throw new BadRequestException(error.message);

    const submittedBy = (data as { submitted_by?: string | null } | null)
      ?.submitted_by;

    if (!submittedBy) return;

    await this.notify([{ userId: submittedBy }], {
      orgId: ctx.orgId,
      spaceId: ctx.spaceId,
      formId: approval.form_id,
      submissionId: approval.submission_id,
      type: 'form_approval_result',
      titleFor: (formName) => `Your submission of "${formName}" was ${status}`,
      bodyFor: (formName) => `Your submission of "${formName}" was ${status}.`,
      linkKind: 'fill',
      metadataExtra: { decision: status, approval_id: approval.id },
    });
  }

  // shared notification triad: in-app insert (per-approver for step_id) + broadcast + email.
  private async notify(
    approvers: ApproverRef[],
    opts: {
      orgId: string;
      spaceId: string;
      formId: string;
      submissionId: string | null;
      type: string;
      titleFor: (formName: string) => string;
      bodyFor: (formName: string, link: string | null) => string;
      linkKind: 'responses' | 'fill';
      // 'pending' → the bell renders inline Approve/Reject; 'none' (default) → non-actionable.
      actionStatus?: string;
      metadataExtra?: Record<string, unknown>;
    },
  ): Promise<void> {
    const deduped = Array.from(
      new Map(
        approvers.filter((a) => !!a.userId).map((a) => [a.userId, a]),
      ).values(),
    );

    if (!deduped.length) return;

    const [{ data: form }, { data: space }] = await Promise.all([
      this.client
        .from(FORMS_TABLE)
        .select('name')
        .eq('id', opts.formId)
        .maybeSingle(),
      this.client
        .from('spaces')
        .select('key')
        .eq('id', opts.spaceId)
        .maybeSingle(),
    ]);

    const formName = (form as { name?: string } | null)?.name ?? 'a form';
    const spaceKey = (space as { key?: string } | null)?.key ?? null;
    const link = spaceKey
      ? opts.linkKind === 'responses'
        ? `/spaces/${spaceKey}/form-builder/${opts.formId}/builder`
        : `/spaces/${spaceKey}/form-builder/${opts.formId}/fill`
      : null;
    const title = opts.titleFor(formName);
    const body = opts.bodyFor(formName, link);

    // Per-approver inserts so each gets their own step_id in metadata.
    const { data: notifs, error: notifErr } = await this.client
      .from('notifications')
      .insert(
        deduped.map((approver) => ({
          organization_id: opts.orgId,
          user_id: approver.userId,
          type: opts.type,
          title,
          body: null,
          is_read: false,
          action_status: opts.actionStatus ?? 'none',
          reference_type: 'form_builder',
          reference_id: opts.formId,
          metadata: {
            form_id: opts.formId,
            form_name: formName,
            // step_id enables inline Approve/Reject in the notification bell
            ...(approver.stepId && { step_id: approver.stepId }),
            // space_id is checked alongside step_id by FormApprovalNotificationItem
            space_id: opts.spaceId,
            ...(opts.submissionId && { submission_id: opts.submissionId }),
            ...(spaceKey && { space_key: spaceKey }),
            ...(opts.metadataExtra ?? {}),
          },
        })),
      )
      .select();

    if (notifErr) {
      this.logger.warn(
        `approval notifications insert failed: ${notifErr.message}`,
      );
    } else {
      for (const n of notifs ?? [])
        void this.broadcast?.broadcastNotification(
          n as Record<string, unknown>,
        );
    }

    const { data: users } = await this.client
      .from('users')
      .select('id, email')
      .in(
        'id',
        deduped.map((a) => a.userId),
      );

    for (const u of (users ?? []) as Array<{
      id: string;
      email: string | null;
    }>) {
      if (!u.email) continue;

      void this.mail
        .sendNotificationEmail(u.email, title, body)
        .catch((err) =>
          this.logger.warn(
            `approval email failed for ${u.id}: ${(err as Error)?.message ?? err}`,
          ),
        );
    }
  }
}
