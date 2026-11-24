/**
 * @fileoverview Service for workflow transition rules — persists the four
 * JSONB arrays (conditions/validators/post_functions/triggers) atomically
 * after schema validation via the workflow-engine HandlerRegistryService
 * and cross-org reference checks against referenced entity tables.
 * @module src/workflow-transitions/workflow-transitions.service
 * @author Rajbha Manek
 */

import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { HandlerRegistryService } from '../workflow-engine/handlers/handler-registry.service';
import { assertRuleReferencesInOrganization } from '../workflow-engine/handlers/rule-reference-validation';
import type { SaveRulesDto } from './dto/save-rules.dto';

export interface WorkflowTransition {
  id: string;
  workflow_id: string;
  name: string;
  description: string | null;
  kind: string;
  to_node_id: string;
  screen_field_group_id: string | null;
  conditions: unknown[];
  validators: unknown[];
  post_functions: unknown[];
  triggers: unknown[];
  properties: Record<string, unknown>;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class WorkflowTransitionsService {
  private static readonly TABLE = 'workflow_transitions';

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly registry: HandlerRegistryService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Persist all four rule arrays for a transition. Performs (in order):
   *   1. Load + verify the transition belongs to the calling org (via its workflow).
   *   2. Validate every item's shape via {@link HandlerRegistryService.validatePayload}.
   *   3. Collect external references and verify each referenced UUID lives in this org.
   *   4. UPDATE the four columns + updated_at in a single statement.
   *   5. Best-effort audit log.
   *
   * @throws NotFoundException when the transition does not exist or belongs to another org.
   * @throws UnprocessableEntityException with `{issues}` on Zod failure,
   *         or with `{missing}` on cross-org references.
   * @throws BadRequestException on raw Supabase errors.
   */
  async saveRules(
    transitionId: string,
    organizationId: string,
    dto: SaveRulesDto,
    actorUserId?: string | null,
  ): Promise<WorkflowTransition> {
    // 1) Verify the transition belongs to this org via its workflow.
    //    `workflows!inner(organization_id)` forces an inner join so a stale
    //    transition pointing at a deleted workflow surfaces as not-found.
    const txR = await this.client
      .from(WorkflowTransitionsService.TABLE)
      .select(
        'id, workflow_id, workflows!inner(organization_id, is_active, is_draft, is_archived)',
      )
      .eq('id', transitionId)
      .maybeSingle();

    if (txR.error) throw new BadRequestException(txR.error.message);
    if (!txR.data) throw new NotFoundException('Transition not found');

    // Supabase typings infer joined rows as a single object when an FK is
    // single-valued, but the runtime client returns the embedded shape
    // either way; cast to a narrow local type.
    const joined = txR.data as unknown as {
      id: string;
      workflow_id: string;
      workflows:
        | {
            organization_id: string;
            is_active: boolean;
            is_draft: boolean;
            is_archived: boolean;
          }
        | {
            organization_id: string;
            is_active: boolean;
            is_draft: boolean;
            is_archived: boolean;
          }[];
    };
    const workflow = Array.isArray(joined.workflows)
      ? joined.workflows[0]
      : joined.workflows;
    const workflowOrg = workflow?.organization_id;

    if (!workflow || workflowOrg !== organizationId) {
      // Cross-org access — surface as 404 to avoid leaking existence.
      throw new NotFoundException('Transition not found');
    }

    if (workflow.is_archived) {
      throw new ConflictException('Cannot edit rules on an archived workflow');
    }

    if (workflow.is_active && !workflow.is_draft) {
      throw new ConflictException(
        'Cannot edit rules on an active workflow; create a draft first.',
      );
    }

    // 2) Schema-validate every rule via the registry. Throws 422 with
    //    `{issues: [{phase, index, type, path, message}, ...]}` on failure.
    this.registry.validatePayload(dto);

    // 3) Collect external references and batch-verify cross-org isolation.
    const refs = this.registry.collectReferences(dto);
    await assertRuleReferencesInOrganization(this.client, organizationId, refs);

    // 4) Single UPDATE for all four JSONB columns + timestamp.
    //    Note: `workflow_transitions` has no `updated_by` column in the
    //    current schema; the `updated_at` trigger maintains the timestamp
    //    on its own, but we set it explicitly to make the audit changes
    //    self-consistent and to provide a deterministic value for tests.
    const upd = await this.client
      .from(WorkflowTransitionsService.TABLE)
      .update({
        conditions: dto.conditions,
        validators: dto.validators,
        post_functions: dto.post_functions,
        triggers: dto.triggers,
        updated_at: new Date().toISOString(),
      })
      .eq('id', transitionId)
      .select()
      .single();

    if (upd.error) throw new BadRequestException(upd.error.message);

    // 5) Best-effort audit — never block the response.
    this.logAudit(organizationId, actorUserId, transitionId, {
      action: 'save_rules',
      conditions_count: dto.conditions.length,
      validators_count: dto.validators.length,
      post_functions_count: dto.post_functions.length,
      triggers_count: dto.triggers.length,
    });

    return upd.data as WorkflowTransition;
  }

  private logAudit(
    organizationId: string,
    actorUserId: string | null | undefined,
    entityId: string,
    changes: Record<string, unknown>,
  ): void {
    if (!actorUserId || !this.auditLogsService) return;
    // logAction is fire-and-forget; AuditLogsService swallows its own errors.
    void this.auditLogsService.logAction(
      organizationId,
      actorUserId,
      'workflow_transition',
      entityId,
      'update',
      changes,
    );
  }
}
