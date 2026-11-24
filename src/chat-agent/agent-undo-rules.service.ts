/**
 * @fileoverview Who may undo what Robert made (ROB-12), read by the Undo itself and by the card.
 * @module src/chat-agent/agent-undo-rules.service
 */
import { Injectable, Optional } from '@nestjs/common';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import { AgentPlansService, type ProductPlanRow } from './agent-plans.service';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { isSuggestionKind, SUGGESTION_KINDS } from './pipeline/agent-kinds';

/** What this release can undo. Spaces and member changes stay: their card says why. */
export const UNDOABLE_KINDS: ReadonlySet<string> = new Set([
  'task',
  'subtask',
  'wiki_page',
  'process',
  'plan_item',
  'plan',
  'plan_link',
  // 1.23: every suggestion has its own Undo.
  ...SUGGESTION_KINDS,
]);

interface UndoTarget {
  kind: string;
  entity_id: string;
  organization_id?: string;
  /** 1.23: a suggestion names its plan on the card. */
  resolved?: unknown;
}

const TABLE: Record<string, string> = {
  task: 'tasks',
  subtask: 'tasks',
  process: 'business_processes',
  wiki_page: 'wiki_pages',
  plan_item: 'tasks',
  plan: 'plans',
};

@Injectable()
export class AgentUndoRulesService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    @Optional() private readonly wikiPermissions?: WikiPermissionsService,
    @Optional() private readonly productPlans?: AgentPlansService,
  ) {}

  isTenantAdmin(user: RequestUser): Promise<boolean> {
    return this.permissions.isAdminOrOwner(user.userId, user.organizationId);
  }

  /**
   * The same right a person's delete needs, asked now, in the space the object is in now: it may
   * have moved, and a card of a new space never knew it. An object that is gone is for the blockers.
   */
  async mayDelete(user: RequestUser, target: UndoTarget): Promise<boolean> {
    const { userId, organizationId } = user;
    // 1.22.1: a link Undo takes it out of the plan: it needs edit rights on that plan now. The
    // task is not deleted, so no task right is asked.
    if (target.kind === 'plan_link') {
      const { data, error } = await this.supabaseAdmin
        .getClient()
        .from('plan_tasks')
        .select('plan_id')
        .eq('id', target.entity_id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!data) return true;
      const plan = await this.productPlans?.planById(user, (data as { plan_id: string }).plan_id);
      return !!plan && !!(await this.productPlans?.canEdit(user, plan as ProductPlanRow));
    }
    // 1.23: a suggestion's Undo is a change to its plan: edit rights on it now; a baseline, the plan's
    // admin level as for a person's delete of one. A plan that is gone is for the blockers.
    if (isSuggestionKind(target.kind)) {
      const planId = (target.resolved as { create?: { planId?: string } } | undefined)?.create?.planId;
      if (!planId) return false;
      const plan = await this.productPlans?.planById(user, planId);
      if (!plan) return true;
      return target.kind === 'plan_baseline'
        ? !!(await this.productPlans?.canDelete(user, plan))
        : !!(await this.productPlans?.canEdit(user, plan));
    }
    const table = TABLE[target.kind];
    if (!table) return false;

    const { data, error } = await this.supabaseAdmin
      .getClient()
      .from(table)
      .select('space_id')
      .eq('id', target.entity_id)
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return true;
    const space = (data as { space_id: string | null }).space_id;

    const held = (orgKey: string, spaceKey: string) => this.orgOrSpace(userId, organizationId, space, orgKey, spaceKey);
    if (target.kind === 'process') return held('can_delete_processes', 'delete_processes');
    // deletePlan's own rule: plan admin level (owner or admin, delete_plans, or an admin row).
    if (target.kind === 'plan') {
      const plan = await this.productPlans?.planById(user, target.entity_id);
      return !!plan && !!(await this.productPlans?.canDelete(user, plan as ProductPlanRow));
    }
    if (target.kind !== 'wiki_page') return held('can_delete_tasks', 'delete_tasks');

    if (!space || !(await this.permissions.hasSpacePermission(userId, organizationId, space, 'delete_wiki_pages')))
      return false;
    // A page can have rules of its own, as for a person's delete.
    if (!this.wikiPermissions) return false;
    return this.wikiPermissions.assertPageAccess(target.entity_id, userId, space, 'can_delete').then(
      () => true,
      () => false,
    );
  }

  private async orgOrSpace(
    userId: string,
    organizationId: string,
    spaceId: string | null,
    orgKey: string,
    spaceKey: string,
  ): Promise<boolean> {
    if (await this.permissions.checkPermission(userId, organizationId, orgKey)) return true;
    return !!spaceId && this.permissions.hasSpacePermission(userId, organizationId, spaceId, spaceKey);
  }
}
