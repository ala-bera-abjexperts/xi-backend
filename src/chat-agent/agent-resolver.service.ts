/**
 * @fileoverview Turns one of Robert's task intents (plus what the invoker edited) into the card
 * the invoker confirms (XE-T353 1.14, plan B2). The same function runs at proposal, at every edit
 * and again at Confirm, always as the invoker and with fresh data, so nothing the model wrote is
 * ever trusted: every id on the card and in `create` comes from a lookup here.
 *
 * The result is stored in `agent_actions.resolved`:
 *  - `fields`: one state per field (ok, check, needs_input, blocked) with a code the client renders;
 *    `options` are the invoker's pickers and are stripped for everyone else by the run view;
 *  - `create`: the exact input of TasksMineWriteService.createTask, built from the fields alone.
 * `confirmable` = no field is needs_input or blocked; checks (advisory or not) never block.
 *
 * Lookups are memoised per batch (one run, one edit or one Confirm), so twenty proposals in one
 * space cost the same reads as one.
 * @module src/chat-agent/agent-resolver.service
 */

import { Injectable, Optional } from '@nestjs/common';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import {
  ChatAccessService,
  type ChatConversationKind,
} from '../chat/chat-access.service';
import { ChatConversationsService } from '../chat/chat-conversations.service';
import { FieldGroupsService } from '../custom-fields/field-groups.service';
import { validateFieldValue } from '../custom-fields/utils/custom-field-validation';
import type { CustomField } from '../custom-fields/models/custom-field.model';
import { OrganizationModulesService } from '../organization-modules/organization-modules.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { ITaskTypeLevel } from '../task-hierarchy-config/models/task-hierarchy-config.model';
import { HierarchyConfigService } from '../hierarchy-config/hierarchy-config.service';
import { TaskHierarchyConfigService } from '../task-hierarchy-config/task-hierarchy-config.service';
import { TaskPrioritiesService } from '../task-priorities/task-priorities.service';
import { TaskStatusesService } from '../task-statuses/task-statuses.service';
import { WorkflowAssignmentsService } from '../workflow-assignments/workflow-assignments.service';
import { AgentRunsRepository } from './agent-runs.repository';
import { MAX_SHARED_RUN_MEMBERS } from './agent-visibility';
import { cleanUntrusted } from './pipeline/agent-prompt';
import { calendarDays, resolveDateWords } from './pipeline/agent-dates';
import { suggestDates, type DateEdge, type DateItem, type DateSource } from './pipeline/agent-plan-dates';
import { generatedRiskSchema, generatedStakeholderSchema } from '../plans/plans-ai.service';
import type { AgentIntent } from './pipeline/agent-schemas';
import {
  HTML_TAG,
  renderWikiDoc,
  SPACE_PLACEHOLDER,
  type WikiBlock,
  type WikiRenderRefs,
  type WikiTaskRef,
} from './pipeline/agent-wiki-render';
import { WikiPermissionsService } from '../wiki/wiki-permissions.service';
import { WikiMineWriteService } from '../wiki/wiki-mine-write.service';
import { AgentGovernanceService } from './agent-governance.service';
import {
  fitPlanItemText,
  PLAN_ITEM_MAX_COST,
  PLAN_ITEM_MAX_HOURS,
  AgentPlansService,
  PLAN_ITEM_PRIORITIES,
  PLAN_ITEM_TYPES,
  PLAN_TYPES,
  type AgentPlanItemType,
  type AgentPlanType,
  type ProductPlanRow,
} from './agent-plans.service';
import {
  freeSpaceKey,
  isContainerKind,
  isMemberKind,
  isNewKind,
  isPlanKind,
  isSuggestionKind,
  placeProcess,
  PROCESS_REQUEST_TYPES,
  PROCESS_SCORE_KEYS,
  SPACE_ROLES,
  type AgentMemberKind,
  type AgentSuggestionKind,
  type AgentSpaceRole,
  type ProcessLevel,
} from './pipeline/agent-kinds';

export type AgentFieldState = 'ok' | 'check' | 'needs_input' | 'blocked';

export type AgentFieldCode =
  | 'required_missing'
  | 'too_long'
  | 'unknown_space'
  | 'no_create_permission'
  | 'module_off'
  | 'unknown_type'
  | 'unknown_status'
  | 'status_fixed_by_workflow'
  | 'unknown_priority'
  | 'ambiguous_person'
  | 'unknown_person'
  | 'not_space_member'
  | 'level_not_allowed'
  | 'level_no_children'
  | 'level_needs_parent'
  | 'assignee_not_in_conversation'
  | 'date_in_past'
  | 'invalid_date'
  | 'new_label'
  | 'parent_not_found'
  | 'parent_other_space'
  | 'resolve_failed'
  | 'no_space_available'
  | 'ambiguous_parent'
  | 'similar_page'
  | 'review_required'
  | 'unknown_reference'
  | 'reference_not_found'
  | 'empty_body'
  | 'unknown_label'
  | 'parent_not_confirmed'
  | 'chart_unverified'
  | 'macro_left_out'
  | 'no_create_space'
  | 'no_create_process'
  | 'module_off_process'
  | 'name_taken'
  | 'invalid_key'
  | 'title_too_short'
  | 'unknown_request_type'
  | 'scores_missing'
  | 'no_manage_permission'
  | 'space_unavailable'
  | 'target_above_you'
  | 'role_above_yours'
  | 'already_member'
  | 'not_member'
  | 'unknown_permission'
  | 'permission_not_yours'
  | 'nothing_to_change'
  | 'keeps_access_org_admin'
  | 'removal_is_final'
  | 'keeps_through_role'
  | 'task_not_found'
  | 'task_other_space'
  | 'already_in_plan'
  | 'link_top_level'
  | 'subtasks_stay_out'
  | 'task_done'
  | 'dependency_self'
  | 'dependency_other_plan'
  | 'dependency_ambiguous'
  | 'dependency_not_in_plan'
  | 'dependency_type_unclear'
  | 'dependency_dates'
  // 1.22: plans and plan items.
  | 'unknown_plan'
  | 'ambiguous_plan'
  | 'plan_required'
  | 'plan_archived'
  | 'plan_state'
  | 'no_edit_plan'
  | 'no_create_plan'
  | 'unknown_plan_type'
  | 'starts_as_draft'
  | 'milestone_one_date'
  | 'milestone_children'
  | 'end_before_start'
  | 'outside_plan_range'
  | 'invalid_number'
  | 'parent_not_in_plan'
  // 1.23: suggestions for an existing plan.
  | 'dependency_exists'
  | 'dependency_cycle'
  | 'has_dates'
  | 'person_item'
  | 'nothing_to_base'
  | 'end_needed'
  | 'start_needed'
  | 'waits_for_card'
  | 'out_of_scale'
  | 'default_value'
  | 'baseline_name'
  | 'no_baseline_right'
  | 'name_only'
  | 'invalid_email'
  | 'plan_first'
  | 'same_name_in_plan';

export interface AgentFieldOption {
  value: string;
  label: string;
  hint?: string;
}

/** One row of a proposal card (contract 4.3); the frontend's `AgentFieldView`. */
export interface AgentFieldView {
  key: string;
  state: AgentFieldState;
  code?: AgentFieldCode;
  params?: Record<string, string | number>;
  value: unknown;
  display?: string;
  said?: string;
  /** Invoker only: the run view strips it for everyone else. */
  options?: AgentFieldOption[];
  advisory?: boolean;
  editable?: boolean;
  /** `custom:<id>` only: the custom_fields row, plus `is_required`. */
  fieldDef?: Record<string, unknown>;
}

/** The input of TasksMineWriteService.createTask, built from the fields only. */
export interface AgentCreatePlan {
  spaceId: string | null;
  summary: string;
  /** Plain text; the executor turns it into escaped paragraphs. */
  description: string | null;
  taskTypeId: string | null;
  /** null when a workflow fixes the status (the task service applies it). */
  statusId: string | null;
  priorityKey: string | null;
  assigneeId: string | null;
  dueDate: string | null;
  labels: string[];
  /** An existing task (by key or id in the intent); a parent of this run is `dependsOn`. */
  parentTaskId: string | null;
  /** Keyed by `custom_fields.field_key`, as tasks.custom_field_values stores them. */
  customFieldValues: Record<string, unknown>;
  /** Ordinal of a space of this run that holds it; `spaceId` is null until Confirm knows the id. */
  pendingSpace?: number | null;
}

/** The input of WikiMineWriteService.createWikiPage (1.15), built from the fields only. */
export interface AgentWikiPlan {
  kind: 'wiki_page';
  spaceId: string | null;
  /** An existing page; a parent page of this run is `dependsOn`. */
  parentPageId: string | null;
  title: string;
  /** The TipTap document agent-wiki-render built; task cards of this run's items are filled in at Confirm. */
  doc: Record<string, unknown>;
  /** wiki_labels ids of the space. */
  labelIds: string[];
  publish: boolean;
  /** Ordinals of this run's task items the page shows as cards. */
  items: number[];
  /** Spaces of the material the page was written from; the card is narrowed when a member cannot see one. */
  readSpaces: string[];
  /** The parent or a referenced page has its own access list. */
  restricted: boolean;
  pendingSpace?: number | null;
}

/** A new space (1.20). Its children wait for its reserved id. */
export interface AgentSpacePlan {
  kind: 'space';
  spaceId: null;
  name: string;
  key: string;
  description: string | null;
  enableWiki: boolean;
  enablePlans?: boolean;
}

export interface AgentProcessPlan {
  kind: 'process';
  spaceId: string | null;
  pendingSpace?: number | null;
  title: string;
  description: string | null;
  requestType: string;
  assigneeId: string | null;
  scores: Record<string, number>;
  /** Its level in the organization's process hierarchy. */
  hierarchyLevelId?: string | null;
  /** A process that exists already; a process of the same request comes through depends_on. */
  parentId?: string;
}

export interface AgentMemberPlan {
  kind: AgentMemberKind;
  spaceId: string | null;
  pendingSpace?: number | null;
  userId: string;
  role: AgentSpaceRole | null;
  grant: string[];
  revoke: string[];
}

export type AgentNewPlan = AgentSpacePlan | AgentProcessPlan | AgentMemberPlan;

/** A new product plan (1.22). Always created as Draft. */
export interface AgentProductPlan {
  kind: 'plan';
  spaceId: string | null;
  pendingSpace?: number | null;
  name: string;
  description: string | null;
  planType: AgentPlanType;
  startDate: string | null;
  endDate: string | null;
  ownerId: string | null;
}

/** A new item of a product plan (1.22): a task plus its plan link. */
export interface AgentPlanItemPlan {
  kind: 'plan_item';
  spaceId: string | null;
  pendingSpace?: number | null;
  /** An existing plan; a plan of this request comes through depends_on (`pendingPlan`). */
  planId: string | null;
  pendingPlan?: number | null;
  /** An existing item of the plan; a parent item of this request comes through depends_on. */
  parentTaskId: string | null;
  name: string;
  description: string | null;
  itemType: AgentPlanItemType;
  startDate: string | null;
  endDate: string | null;
  ownerId: string | null;
  priority: string | null;
  estimatedHours: number | null;
  estimatedCost: number | null;
  progress: number | null;
  /** 1.22.1: written after the item exists, each on its own; a failed one leaves the item. */
  dependencies?: AgentPlanDependency[];
}

/** 1.22.1: what a dependency of a new plan item is; the item is the successor or the predecessor. */
export type AgentDependencyType = 'finish_to_start' | 'start_to_start' | 'finish_to_finish' | 'start_to_finish';
export const DEPENDENCY_TYPE_NAMES: Record<AgentDependencyType, string> = {
  finish_to_start: 'Finish to Start',
  start_to_start: 'Start to Start',
  finish_to_finish: 'Finish to Finish',
  start_to_finish: 'Start to Finish',
};
export interface AgentPlanDependency {
  type: AgentDependencyType;
  thisIs: 'successor' | 'predecessor';
  /** An existing item of the plan, or a card of this request (its ordinal). */
  otherTaskId: string | null;
  otherOrdinal: number | null;
}

/** 1.22.1: an existing task into a plan. Only the plan_tasks row is made; the task is never written. */
export interface AgentPlanLinkPlan {
  kind: 'plan_link';
  spaceId: string | null;
  planId: string | null;
  pendingPlan?: number | null;
  taskId: string;
  taskKey: string;
  itemType: AgentPlanItemType;
}

export const isPlanLinkPlan = (plan: AgentPlanOf | null | undefined): plan is AgentPlanLinkPlan =>
  !!plan && (plan as { kind?: string }).kind === 'plan_link';

/** 1.23: what each suggestion card writes when confirmed, field by field as the card shows it. */
interface SuggestionBase {
  spaceId: string | null;
  planId: string;
  /** The one line on the card saying why (the model's words, or where the dates come from). */
  reason: string | null;
}
export interface AgentPlanDependencyPlan extends SuggestionBase {
  kind: 'plan_dependency';
  sourceTaskId: string;
  targetTaskId: string;
  type: AgentDependencyType;
}
export interface AgentPlanDatesPlan extends SuggestionBase {
  kind: 'plan_dates';
  taskId: string;
  start: string;
  end: string;
  duration: number;
}
export interface AgentPlanRiskPlan extends SuggestionBase {
  kind: 'plan_risk';
  name: string;
  description: string | null;
  riskType: 'risk' | 'opportunity';
  category: string | null;
  probability: number;
  impact: number;
  mitigation: string | null;
  contingency: string | null;
  ownerId: string | null;
}
export interface AgentPlanStakeholderPlan extends SuggestionBase {
  kind: 'plan_stakeholder';
  name: string;
  role: string | null;
  organization: string | null;
  email: string | null;
  power: number;
  interest: number;
  attitude: 'supportive' | 'neutral' | 'resistant' | null;
  engagement: string | null;
  /** The org user this stakeholder is, when that is certain; else a name only. */
  linkedUserId: string | null;
}
export interface AgentPlanBaselinePlan extends SuggestionBase {
  kind: 'plan_baseline';
  name: string;
  items: number;
}
export type AgentSuggestionPlan =
  | AgentPlanDependencyPlan
  | AgentPlanDatesPlan
  | AgentPlanRiskPlan
  | AgentPlanStakeholderPlan
  | AgentPlanBaselinePlan;
export const isSuggestionPlan = (plan: AgentPlanOf | null | undefined): plan is AgentSuggestionPlan =>
  !!plan && isSuggestionKind((plan as { kind?: string }).kind);

export type AgentPlanOf =
  | AgentCreatePlan
  | AgentWikiPlan
  | AgentNewPlan
  | AgentProductPlan
  | AgentPlanItemPlan
  | AgentPlanLinkPlan
  | AgentSuggestionPlan;

export const isProductPlan = (plan: AgentPlanOf | null | undefined): plan is AgentProductPlan =>
  !!plan && (plan as { kind?: string }).kind === 'plan';
export const isPlanItemPlan = (plan: AgentPlanOf | null | undefined): plan is AgentPlanItemPlan =>
  !!plan && (plan as { kind?: string }).kind === 'plan_item';

export const isNewPlan = (plan: AgentPlanOf | null | undefined): plan is AgentNewPlan =>
  !!plan && isNewKind(String((plan as { kind?: string }).kind));

/** A task plan: the only one without a kind of its own. */
export const isTaskPlan = (plan: AgentPlanOf | null | undefined): plan is AgentCreatePlan =>
  !!plan && !(plan as { kind?: string }).kind;

export const isWikiPlan = (plan: AgentPlanOf | null | undefined): plan is AgentWikiPlan =>
  !!plan && (plan as AgentWikiPlan).kind === 'wiki_page';

/** The task type of a task plan; a page has none. */
export const taskTypeOf = (plan: AgentPlanOf | null | undefined): string | null =>
  isTaskPlan(plan) ? plan.taskTypeId : null;

/** What a proposal's children read from it: `batch.siblings` holds one per ordinal. */
export function siblingOf(
  ordinal: number,
  kind: string,
  resolved: { create?: AgentPlanOf | null; title?: string } | null | undefined,
): AgentSibling {
  const plan = resolved?.create;
  const pending = plan && 'pendingSpace' in plan ? (plan.pendingSpace ?? null) : null;
  return {
    spaceId: plan?.spaceId ?? null,
    taskTypeId: taskTypeOf(plan),
    kind,
    pendingSpace: kind === 'space' ? ordinal : pending,
    title: resolved?.title ?? '',
    ...(plan && 'userId' in plan && kind === 'space_member_add' && { userId: plan.userId }),
    ...(plan && 'requestType' in plan && { hierarchyLevelId: plan.hierarchyLevelId ?? null, requestType: plan.requestType }),
    // 1.22: what an item under a plan or under another item reads from it.
    ...(isProductPlan(plan) && { pendingPlan: ordinal, range: { start: plan.startDate, end: plan.endDate } }),
    ...(isPlanLinkPlan(plan) && {
      planId: plan.planId,
      pendingPlan: plan.pendingPlan ?? null,
      itemType: plan.itemType,
      taskKey: plan.taskKey,
    }),
    // 1.23: a suggested dependency is an edge the dates of the same request may rely on.
    ...(isSuggestionPlan(plan) && { planId: plan.planId }),
    ...(plan && (plan as { kind?: string }).kind === 'plan_dependency' && {
      edge: {
        source: (plan as AgentPlanDependencyPlan).sourceTaskId,
        target: (plan as AgentPlanDependencyPlan).targetTaskId,
        type: (plan as AgentPlanDependencyPlan).type,
      },
    }),
    ...(isPlanItemPlan(plan) && {
      planId: plan.planId,
      pendingPlan: plan.pendingPlan ?? null,
      itemType: plan.itemType,
      range: (resolved as { range?: AgentSibling['range'] } | null)?.range,
    }),
  };
}

/** What agent_actions.resolved holds. */
export interface AgentResolved {
  title: string;
  description: string | null;
  confirmable: boolean;
  fields: AgentFieldView[];
  create: AgentPlanOf | null;
  /** plan_item: the start and end of its plan, for the items under it (1.22). */
  range?: { start: string | null; end: string | null };
}

/**
 * What the run's handles stood for, kept on a wiki intent (handles exist only in the run's
 * context, and Confirm resolves again without it).
 */
export interface AgentWikiHandles {
  people: Record<string, { userId: string; name: string }>;
  /** m7 → chat message id. */
  messages: Record<string, string>;
  /** m7 → "Ala Bera, 29 Oct 09:15", the text of its link under Sources. */
  messageLabels?: Record<string, string>;
  tasks: Record<string, { key: string; spaceId: string | null }>;
  pages: Record<string, { id: string; spaceId: string | null; restricted: boolean }>;
  /** Refs of this run's items ("i2") → ordinal, for task and subtask items only. */
  items: Record<string, number>;
  /** Spaces of all material read for the run. */
  readSpaces: string[];
  restricted: boolean;
  /** Task keys the request named that the invoker cannot see. */
  missing: string[];
  /** 1.18: the shared files the page may cite (F1 → its attachment and the message that carries it). */
  files?: Record<string, { attachmentId: string; name: string; messageId: string | null }>;
  /** Every value the numbers of the conversation and the T/W material stand for (charts use only these). */
  numbers?: string[];
  /** Task keys the request itself names (a page from them never comes out empty). */
  asked?: string[];
}

/** The intent as stored: the model's item plus the user id its participant handle stood for. */
export type AgentStoredIntent = AgentIntent & {
  assignee: AgentIntent['assignee'] & { user_id?: string | null };
  wiki?: AgentWikiHandles;
  /** The proposal this one replaced as a follow-up change (1.17), and how many changes in a row. */
  revision_of?: string | null;
  revision_no?: number;
  /** wiki_page: the language the plan wrote its objects in (the page's labels follow it). */
  object_language?: string;
  /** space: a page of this request goes in it, so its wiki is switched on with it. */
  needs_wiki?: boolean;
  /** space (1.22): a plan of this request goes in it, so its plans module is switched on with it. */
  needs_plans?: boolean;
};

export type AgentActionKind =
  | 'task'
  | 'subtask'
  | 'wiki_page'
  | 'space'
  | 'process'
  | 'plan'
  | 'plan_item'
  | 'plan_link'
  | AgentSuggestionKind
  | AgentMemberKind;

/** One proposal of the run, as the others see it. */
export interface AgentSibling {
  spaceId: string | null;
  taskTypeId: string | null;
  kind?: string;
  /** Ordinal of the new space of this run it lives in. */
  pendingSpace?: number | null;
  title?: string;
  /** space_member_add: who joins, so a task may be assigned to them. */
  userId?: string;
  /** process: where it stands, so a process under it can be checked. */
  hierarchyLevelId?: string | null;
  requestType?: string;
  /** 1.22: the plan of this run an item goes in (its ordinal), or the existing one. */
  pendingPlan?: number | null;
  planId?: string | null;
  itemType?: string;
  range?: { start: string | null; end: string | null };
  /** plan_link: the key of the existing task it adds, so a dependency of the same answer may name it. */
  taskKey?: string;
  /** 1.23: a suggested dependency (plan_dependency), for the cycle check and the dates. */
  edge?: { source: string; target: string; type: AgentDependencyType };
}

export interface AgentResolveAction {
  kind: AgentActionKind;
  intent: AgentStoredIntent;
  overrides: Record<string, unknown>;
  /** Ordinal of the parent proposal in the same run. */
  dependsOn: number | null;
}

/** One resolve batch: the invoker, the conversation and the lookups shared by its actions. */
export interface AgentResolveBatch {
  invoker: Pick<RequestUser, 'userId' | 'organizationId'>;
  conversation: {
    id: string;
    kind: ChatConversationKind;
    space_id: string | null;
  };
  timezone: string;
  now: Date;
  /** Space and type of the other proposals of the run, by ordinal (for `dependsOn`). */
  siblings: Map<number, AgentSibling>;
  memo: Map<string, Promise<unknown>>;
}

/** Keys an edit may set; `custom:<uuid>` besides. */
export const AGENT_FIELD_KEYS = [
  'title',
  'description',
  'space',
  'type',
  'status',
  'priority',
  'assignee',
  'due',
  'labels',
  'parent',
] as const;

/** Keys an edit of a wiki page proposal may set (1.15). The body is edited in the wiki after creation. */
export const AGENT_WIKI_FIELD_KEYS = [
  'title',
  'space',
  'parentPage',
  'labels',
  'publish',
] as const;

/** Keys an edit of a new space, a process or a member change may set (1.20). */
export const AGENT_SPACE_FIELD_KEYS = ['title', 'description', 'key'] as const;
export const AGENT_PROCESS_FIELD_KEYS = ['title', 'description', 'space', 'requestType', 'assignee', 'scores'] as const;
export const AGENT_MEMBER_FIELD_KEYS = ['space', 'member', 'role'] as const;
/** 1.22: a new plan, and a new item of a plan. */
export const AGENT_PLAN_FIELD_KEYS = ['title', 'description', 'space', 'planType', 'start', 'end', 'assignee'] as const;
export const AGENT_PLAN_ITEM_FIELD_KEYS = [
  'title',
  'description',
  'plan',
  'parent',
  'itemType',
  'start',
  'end',
  'assignee',
  'priority',
  'estimatedHours',
  'estimatedCost',
  'progress',
] as const;
/** 1.23: what a person may change on a suggestion card before confirming it. */
export const AGENT_SUGGESTION_FIELD_KEYS: Record<AgentSuggestionKind, readonly string[]> = {
  plan_dependency: ['plan', 'predecessor', 'successor', 'dependencyType'],
  plan_dates: ['plan', 'start', 'end'],
  plan_risk: ['title', 'description', 'plan', 'riskType', 'category', 'probability', 'impact', 'mitigation', 'contingency', 'assignee'],
  plan_stakeholder: ['title', 'plan', 'role', 'organization', 'email', 'power', 'interest', 'attitude', 'engagement', 'assignee'],
  plan_baseline: ['title', 'plan'],
};

/** Where a kind is created: its module (null: no module of its own) and the space permission it needs. */
interface CreateScope {
  module: 'tasks' | 'wiki' | 'processes' | 'plans' | null;
  perm: 'create_tasks' | 'create_wiki_pages' | 'create_processes' | 'manage_members' | 'create_plans';
}
const TASK_SCOPE: CreateScope = { module: 'tasks', perm: 'create_tasks' };
const WIKI_SCOPE: CreateScope = { module: 'wiki', perm: 'create_wiki_pages' };
const PROCESS_SCOPE: CreateScope = { module: 'processes', perm: 'create_processes' };
const MEMBER_SCOPE: CreateScope = { module: null, perm: 'manage_members' };
const PLAN_SCOPE: CreateScope = { module: 'plans', perm: 'create_plans' };
const scopeOf = (kind: AgentActionKind) =>
  kind === 'wiki_page'
    ? WIKI_SCOPE
    : kind === 'process'
      ? PROCESS_SCOPE
      : kind === 'plan'
        ? PLAN_SCOPE
        : isMemberKind(kind)
          ? MEMBER_SCOPE
          : TASK_SCOPE;
const MAX_PLAN_NAME = 255;
const MAX_PLAN_OPTIONS = 50;
/** Deepest level a parent may have: the wiki stops at 10. */
const MAX_PARENT_LEVEL = 9;
const MAX_SPACE_NAME = 100;
const MIN_PROCESS_TITLE = 3;
const MAX_PROCESS_TITLE = 200;
const SPACE_KEY = /^[A-Z0-9]{2,8}$/;
const MAX_WIKI_LABEL = 50;

export const MAX_TITLE = 500;
export const MAX_DESCRIPTION = 50_000;
export const MAX_LABELS = 20;
const MAX_LABEL = 100;
const MAX_SPACE_OPTIONS = 50;
const MAX_PEOPLE = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Plain text from whatever the model wrote: no HTML tags, no markdown images, links reduced to
 * their text, no invisible characters, whitespace collapsed per line.
 */
export function stripMarkup(text: string | null | undefined): string {
  return cleanUntrusted(text ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(HTML_TAG, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** The language a page is written in: the plan's object language, stored on the intent by the worker. */
function languageOf(action: { intent: { wiki?: unknown } & Record<string, unknown> }): 'de' | 'en' | 'other' {
  const lang = (action.intent as { object_language?: string }).object_language;
  return lang === 'de' || lang === 'en' ? lang : 'other';
}

/** Accent- and case-insensitive key for matching names the model used. */
export function nameKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** A real calendar day as YYYY-MM-DD, or null. */
export function strictDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = ISO_DAY.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d
    ? value
    : null;
}

const cut = (text: string, max: number) =>
  Array.from(text).slice(0, max).join('');

/** "AMBER-P2 Q4 Security", as the plan list shows a plan. */
const planLabel = (p: Pick<ProductPlanRow, 'plan_key' | 'name'>) => [p.plan_key, p.name].filter(Boolean).join(' ');
/** The calendar day of a date or timestamp column. */
const day = (value: string | null | undefined) => (value ? value.slice(0, 10) : null);

interface SpaceRow {
  id: string;
  key: string;
  name: string;
  is_archived: boolean | null;
}

interface StatusRow {
  id: string;
  key: string;
  name: string;
}

interface PriorityRow {
  id: string;
  key: string;
  name: string;
  space_id: string | null;
}

interface PersonRow {
  id: string;
  name: string;
  email: string | null;
}

/** A task key alone ("AMBER-T12", "XE-T353"). */
const TASK_KEY_ONLY = /^[A-Z][A-Z0-9]*-[A-Z]?\d+$/i;

interface LinkTaskRow {
  id: string;
  key: string;
  summary: string;
  space_id: string;
  parent_task_id: string | null;
  start_date: string | null;
  end_date: string | null;
  assigned_to: string | null;
  plans: string[];
  subtasks: number;
  done: boolean;
}

interface AgentDependsIntent {
  item: string | null;
  key: string | null;
  said: string | null;
  type: string;
  this_is: string;
  words: string;
  ordinal?: number | null;
}

/**
 * The type the words say, English and German, most specific first; null when they say none.
 * "Pen test starts after Build ends" is finish to start; "can't finish until Support starts" is
 * start to finish.
 */
export function dependencyTypeOf(words: string): AgentDependencyType | null {
  const w = words.toLowerCase();
  if (/(can'?t|cannot|can not|may not)\s+(finish|end|close)\b.*\b(until|before)\b.*\b(starts?|begins?)\b|kann\s+erst\s+(enden|abgeschlossen|fertig)\b.*\b(beginnt|startet|anfängt)\b/.test(w))
    return 'start_to_finish';
  if (/\b(finish(es)?|ends?|completes?)\s+(together\s+)?with\b|\b(endet|abschließt|fertig\s+wird)\s+(zusammen\s+)?mit\b|\bgleichzeitig\s+(enden|fertig)\b/.test(w))
    return 'finish_to_finish';
  if (/\b(starts?|begins?)\s+(together\s+)?with\b|\b(beginnt|startet|anfängt)\s+(zusammen\s+)?mit\b|\bgleichzeitig\s+(beginnen|starten)\b/.test(w))
    return 'start_to_start';
  if (/\b(after|once|following|when)\b|\bbefore\b|\b(nach|sobald|bevor|wenn)\b|\bvor\s+(dem|der|beginn|start)\b/.test(w))
    return 'finish_to_start';
  return null;
}

/** Whether known dates already break the dependency (the item may still be planned so). */
function breaksDependency(
  dep: AgentPlanDependency,
  own: { start: string | null; end: string | null },
  other: { start: string | null; end: string | null },
): boolean {
  const [pred, succ] = dep.thisIs === 'successor' ? [other, own] : [own, other];
  const pick = (d: { start: string | null; end: string | null }, edge: 'start' | 'end') => (edge === 'start' ? d.start : d.end) ?? (edge === 'start' ? d.end : d.start);
  const [from, to] =
    dep.type === 'finish_to_start' ? [pick(pred, 'end'), pick(succ, 'start')]
    : dep.type === 'start_to_start' ? [pick(pred, 'start'), pick(succ, 'start')]
    : dep.type === 'finish_to_finish' ? [pick(pred, 'end'), pick(succ, 'end')]
    : [pick(pred, 'start'), pick(succ, 'end')];
  return !!from && !!to && to < from;
}

/** 1.23: one plan as agent_plan_graph returns it. */
interface PlanGraphItem {
  link_id: string;
  task_id: string;
  key: string | null;
  summary: string;
  item_type: string;
  start_date: string | null;
  end_date: string | null;
  duration: number | null;
  estimated_time: number | null;
  parent_task_id: string | null;
  robert: boolean;
}
interface PlanGraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
}
interface PlanGraph {
  items: PlanGraphItem[];
  edges: PlanGraphEdge[];
}
type EndRef = { key: string | null; said: string | null } | undefined;
type RiskIntent = {
  risk_type: string;
  category: string | null;
  probability: number | null;
  impact: number | null;
  mitigation: string | null;
  contingency: string | null;
};
type StakeholderIntent = {
  role: string | null;
  organization: string | null;
  email: string | null;
  power: number | null;
  interest: number | null;
  attitude: string | null;
  engagement: string | null;
};
type SuggestionOut = { title: string; description?: string | null; create: AgentSuggestionPlan | null };
const itemLabel = (i: Pick<PlanGraphItem, 'key' | 'summary'>) => [i.key, i.summary].filter(Boolean).join(' ');

/** Can `to` be reached from `from` over these edges? (A new edge to → from would close a cycle.) */
export function reaches(edges: readonly (readonly [string, string])[], from: string, to: string): boolean {
  const next = new Map<string, string[]>();
  for (const [a, b] of edges) next.set(a, [...(next.get(a) ?? []), b]);
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift() as string;
    if (at === to) return true;
    for (const n of next.get(at) ?? []) if (!seen.has(n)) (seen.add(n), queue.push(n));
  }
  return false;
}

@Injectable()
export class AgentResolverService {
  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissions: PermissionsService,
    private readonly access: ChatAccessService,
    private readonly conversations: ChatConversationsService,
    private readonly hierarchy: TaskHierarchyConfigService,
    private readonly assignments: WorkflowAssignmentsService,
    private readonly statuses: TaskStatusesService,
    private readonly priorities: TaskPrioritiesService,
    private readonly fieldGroups: FieldGroupsService,
    private readonly modules: OrganizationModulesService,
    private readonly runs: AgentRunsRepository,
    // Wiki pages (1.15). Optional so the task-only specs build the resolver as before.
    @Optional() private readonly wikiPermissions?: WikiPermissionsService,
    @Optional() private readonly wikiWrite?: WikiMineWriteService,
    // Spaces, members and processes (1.20).
    @Optional() private readonly governance?: AgentGovernanceService,
    @Optional() private readonly processHierarchy?: HierarchyConfigService,
    // Plans and plan items (1.22).
    @Optional() private readonly productPlans?: AgentPlansService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** A fresh batch; pass the same one to every resolve of one run, edit or Confirm. */
  batch(
    args: Omit<AgentResolveBatch, 'memo' | 'siblings' | 'now'> & {
      now?: Date;
    },
  ): AgentResolveBatch {
    return {
      ...args,
      now: args.now ?? new Date(),
      siblings: new Map(),
      memo: new Map(),
    };
  }

  /**
   * Never throws: a failed lookup turns the card into a blocked `resolve_failed` (plan B3), so
   * one bad proposal never takes the run or the other proposals with it.
   */
  async resolve(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
  ): Promise<AgentResolved> {
    try {
      return await this.resolveFields(batch, action);
    } catch {
      const title = cut(
        stripMarkup(this.text(action, 'title') ?? action.intent.title),
        MAX_TITLE,
      );
      return {
        title,
        description: null,
        confirmable: false,
        fields: [
          { key: 'title', state: 'ok', value: title },
          {
            key: 'space',
            state: 'blocked',
            code: 'resolve_failed',
            value: null,
          },
        ],
        create: null,
      };
    }
  }

  /**
   * The one space a request names by key ("AMBER") or full name, among the spaces the invoker
   * may create tasks in; null when it names none or several. A fallback for intents where the
   * model left the space empty although the request said it.
   */
  async spaceNamedIn(
    batch: AgentResolveBatch,
    request: string,
    kind: AgentActionKind = 'task',
  ): Promise<string | null> {
    const text = ` ${nameKey(request).replace(/[^\p{L}\p{N}]+/gu, ' ')} `;
    const named = (await this.allowedSpaces(batch, scopeOf(kind))).filter((s) => {
      const name = nameKey(s.name)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
      return (
        new RegExp(
          `(^|[^\\p{L}\\p{N}])${s.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`,
          'u',
        ).test(request) ||
        (name.length > 0 && text.includes(` ${name} `))
      );
    });
    return named.length === 1 ? named[0].key : null;
  }

  /**
   * Whether someone who reads the conversation cannot view one of these spaces; the run is
   * then narrowed to its invoker, so a card never shows a private space (plan B3).
   * ponytail: a space channel narrows for any other target space instead of listing every
   * viewer of its space; list them when cross-space proposals in channels need sharing.
   */
  async hidesFromAudience(
    batch: AgentResolveBatch,
    spaceIds: (string | null | undefined)[],
  ): Promise<boolean> {
    const ids = [...new Set(spaceIds.filter((id): id is string => !!id))];
    const { conversation, invoker } = batch;
    if (ids.length === 0) return false;
    if (conversation.kind === 'space')
      return ids.some((id) => id !== conversation.space_id);

    const { data, error } = await this.client
      .from('chat_members')
      .select('user_id')
      .eq('conversation_id', conversation.id)
      .eq('organization_id', invoker.organizationId)
      .limit(MAX_SHARED_RUN_MEMBERS + 1);
    if (error) return true;

    for (const { user_id: userId } of (data ?? []) as { user_id: string }[]) {
      for (const id of ids) {
        if (
          !(await this.access.canViewSpace(userId, invoker.organizationId, id))
        )
          return true;
      }
    }
    return false;
  }

  private text(action: AgentResolveAction, key: string): string | undefined {
    const value = action.overrides[key];
    return typeof value === 'string' ? value : undefined;
  }

  private has(action: AgentResolveAction, key: string): boolean {
    return key in action.overrides;
  }

  private memo<T>(
    batch: AgentResolveBatch,
    key: string,
    load: () => Promise<T>,
  ): Promise<T> {
    let hit = batch.memo.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      batch.memo.set(key, hit);
    }
    return hit;
  }

  private async resolveFields(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
  ): Promise<AgentResolved> {
    if (action.kind === 'wiki_page') return this.resolveWiki(batch, action);
    if (action.kind === 'space') return this.resolveNewSpace(batch, action);
    if (action.kind === 'process') return this.resolveProcess(batch, action);
    if (action.kind === 'plan') return this.resolveProductPlan(batch, action);
    if (action.kind === 'plan_item') return this.resolvePlanItem(batch, action);
    if (action.kind === 'plan_link') return this.resolvePlanLink(batch, action);
    if (isSuggestionKind(action.kind)) return this.resolveSuggestion(batch, action);
    if (isMemberKind(action.kind)) return this.resolveMember(batch, action);
    const { intent } = action;
    const fields: AgentFieldView[] = [];

    // Title and description: plain text only, whatever the model or the invoker sent.
    const rawTitle = stripMarkup(this.text(action, 'title') ?? intent.title);
    const title = cut(rawTitle.replace(/\s+/g, ' '), MAX_TITLE);
    fields.push(
      !title
        ? {
            key: 'title',
            state: 'blocked',
            code: 'required_missing',
            value: '',
          }
        : Array.from(rawTitle).length > MAX_TITLE
          ? {
              key: 'title',
              state: 'check',
              code: 'too_long',
              params: { max: MAX_TITLE },
              value: title,
            }
          : { key: 'title', state: 'ok', value: title },
    );
    const description =
      cut(
        stripMarkup(
          this.has(action, 'description')
            ? this.text(action, 'description')
            : intent.description,
        ),
        MAX_DESCRIPTION,
      ) || null;
    fields.push({ key: 'description', state: 'ok', value: description });

    const space = await this.resolveSpace(batch, action, fields);
    const spaceId = space?.id ?? null;
    const pendingSpace = this.pendingSpaceOf(batch, action);
    const parent = await this.resolveParent(batch, action, spaceId, fields);
    let type: ITaskTypeLevel | null = null;
    let statusId: string | null = null;
    let priorityKey: string | null = null;
    if (spaceId) {
      type = await this.resolveType(
        batch,
        action,
        spaceId,
        parent.typeId,
        fields,
      );
      statusId = await this.resolveStatus(batch, action, spaceId, type, fields);
      priorityKey = await this.resolvePriority(
        batch,
        action,
        spaceId,
        type,
        fields,
      );
    } else {
      // These depend on the space: shown empty until one is picked.
      for (const key of ['type', 'status', 'priority'])
        fields.push({ key, state: 'ok', value: null, editable: false });
      // A space of this request has only the organization's priorities, and those are known.
      if (pendingSpace !== null) priorityKey = await this.orgPriority(batch, action, fields);
    }
    const assigneeId = await this.resolveAssignee(
      batch,
      action,
      spaceId,
      fields,
    );
    const dueDate = this.resolveDue(batch, action, fields);
    const labels = await this.resolveLabels(batch, action, spaceId, fields);
    const customFieldValues =
      spaceId && type
        ? await this.resolveCustomFields(
            batch,
            action,
            spaceId,
            type.id,
            fields,
          )
        : {};

    // Move the parent row to the end, where the card shows it.
    const parentAt = fields.findIndex((f) => f.key === 'parent');
    if (parentAt >= 0) fields.push(...fields.splice(parentAt, 1));

    const confirmable = fields.every(
      (f) => f.state !== 'needs_input' && f.state !== 'blocked',
    );

    return {
      title,
      description,
      confirmable,
      fields,
      create: {
        spaceId,
        summary: title,
        description,
        taskTypeId: type?.id ?? null,
        statusId,
        priorityKey,
        assigneeId,
        dueDate,
        labels,
        parentTaskId: parent.taskId,
        customFieldValues,
        ...(pendingSpace !== null && { pendingSpace }),
      },
    };
  }

  /** The new space of this run an action hangs under, by its parent chain; null for any other. */
  private pendingSpaceOf(batch: AgentResolveBatch, action: AgentResolveAction): number | null {
    if (action.dependsOn === null) return null;
    return batch.siblings.get(action.dependsOn)?.pendingSpace ?? null;
  }

  private async orgPriority(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
  ): Promise<string | null> {
    const { said, level } = action.intent.priority;
    if (!said && level === 'none') return null;
    const rows = await this.memo(batch, 'org-priorities', async () =>
      (await this.priorities.getAll(batch.invoker.organizationId, undefined, { is_active: 'true' })).map(
        (p) => p as unknown as PriorityRow,
      ),
    );
    const find = (word: string) =>
      rows.find((p) => p.key.toLowerCase() === nameKey(word) || nameKey(p.name) === nameKey(word));
    const chosen = (said ? find(said) : undefined) ?? (level !== 'none' ? find(level) : undefined);
    const row = fields.find((f) => f.key === 'priority');
    if (row && chosen) Object.assign(row, { value: chosen.id, display: chosen.name });
    if (row && !chosen) Object.assign(row, { state: 'check', code: 'unknown_priority', ...(said && { said }) });
    return chosen?.key ?? null;
  }

  // ---------------------------------------------------------------------------
  // Spaces, processes and members (1.20)
  // ---------------------------------------------------------------------------

  private async resolveNewSpace(batch: AgentResolveBatch, action: AgentResolveAction): Promise<AgentResolved> {
    const { intent } = action;
    const fields: AgentFieldView[] = [];
    const raw = stripMarkup(this.text(action, 'title') ?? intent.title).replace(/\s+/g, ' ');
    const name = cut(raw, MAX_SPACE_NAME);
    const existing = await this.spaceNames(batch);
    const taken = existing.some((s) => nameKey(s.name) === nameKey(name));
    fields.push(
      !name
        ? { key: 'title', state: 'needs_input', code: 'required_missing', value: '' }
        : taken
          ? { key: 'title', state: 'needs_input', code: 'name_taken', value: name, params: { name } }
          : Array.from(raw).length > MAX_SPACE_NAME
            ? { key: 'title', state: 'check', code: 'too_long', params: { max: MAX_SPACE_NAME }, value: name }
            : { key: 'title', state: 'ok', value: name },
    );
    const description =
      cut(stripMarkup(this.has(action, 'description') ? this.text(action, 'description') : intent.description), 1000) || null;
    fields.push({ key: 'description', state: 'ok', value: description });

    const keys = new Set(existing.map((s) => s.key.toUpperCase()));
    const wanted = this.text(action, 'key') ?? intent.space_key ?? null;
    const key = wanted ? wanted.trim().toUpperCase() : freeSpaceKey(name, keys);
    fields.push(
      !SPACE_KEY.test(key)
        ? { key: 'key', state: 'needs_input', code: 'invalid_key', value: key }
        : keys.has(key)
          ? { key: 'key', state: 'needs_input', code: 'name_taken', value: key, params: { name: key } }
          : { key: 'key', state: 'ok', value: key },
    );

    if (!(await this.governance?.canCreateSpaces(batch.invoker)))
      fields.push({ key: 'space', state: 'blocked', code: 'no_create_space', value: null, editable: false });

    const enableWiki = (intent as AgentStoredIntent).needs_wiki === true;
    if (enableWiki) fields.push({ key: 'wikiModule', state: 'ok', value: true, editable: false });
    const enablePlans = (intent as AgentStoredIntent).needs_plans === true;
    if (enablePlans) fields.push({ key: 'plansModule', state: 'ok', value: true, editable: false });

    return {
      title: name,
      description,
      confirmable: fields.every((f) => f.state !== 'needs_input' && f.state !== 'blocked'),
      fields,
      create: { kind: 'space', spaceId: null, name, key, description, enableWiki, ...(enablePlans && { enablePlans }) },
    };
  }

  /** Every space's name and key, deleted ones being removed too: the unique indexes count them. */
  private spaceNames(batch: AgentResolveBatch): Promise<{ name: string; key: string }[]> {
    return this.memo(batch, 'space-names', async () => {
      const { data, error } = await this.client
        .from('spaces')
        .select('name, key')
        .eq('organization_id', batch.invoker.organizationId);
      if (error) throw new Error(error.message);
      return (data ?? []) as { name: string; key: string }[];
    });
  }

  private async resolveProcess(batch: AgentResolveBatch, action: AgentResolveAction): Promise<AgentResolved> {
    const { intent } = action;
    const fields: AgentFieldView[] = [];
    const raw = stripMarkup(this.text(action, 'title') ?? intent.title).replace(/\s+/g, ' ');
    const title = cut(raw, MAX_PROCESS_TITLE);
    fields.push(
      Array.from(title).length < MIN_PROCESS_TITLE
        ? { key: 'title', state: 'needs_input', code: 'title_too_short', value: title, params: { max: MIN_PROCESS_TITLE } }
        : Array.from(raw).length > MAX_PROCESS_TITLE
          ? { key: 'title', state: 'check', code: 'too_long', params: { max: MAX_PROCESS_TITLE }, value: title }
          : { key: 'title', state: 'ok', value: title },
    );
    const description =
      cut(stripMarkup(this.has(action, 'description') ? this.text(action, 'description') : intent.description), 2000) || null;
    fields.push({ key: 'description', state: 'ok', value: description });

    const space = await this.resolveSpace(batch, action, fields);
    const pendingSpace = this.pendingSpaceOf(batch, action);

    const parentFields: AgentFieldView[] = [];
    const parent = await this.parentProcess(batch, action, space?.id ?? null, parentFields);
    const levels = await this.levelsOf(batch, space?.id ?? null);

    const options = PROCESS_REQUEST_TYPES.map((t) => ({ value: t, label: t }));
    const said = this.text(action, 'requestType') ?? intent.request_type ?? null;
    const named = said ? PROCESS_REQUEST_TYPES.find((t) => nameKey(t) === nameKey(said)) : undefined;
    // A parent that was named and not found is the question; where it would stand comes after.
    const placed = parentFields.some((f) => f.code === 'parent_not_found')
      ? { levelId: null, allowed: [] as string[] }
      : placeProcess(levels, parent, said && !named ? said : (named ?? null));
    const requestType = named ?? (said ? undefined : placed.requestType);
    // Refused: only what fits may be offered, which can be nothing. Otherwise every type is open.
    const fitting = placed.problem || placed.allowed.length ? placed.allowed.map((t) => ({ value: t, label: t })) : options;
    fields.push(
      !requestType
        ? {
            key: 'requestType',
            state: 'needs_input',
            code: 'unknown_request_type',
            value: null,
            ...(said && { said }),
            options: fitting,
          }
        : placed.problem
          ? {
              key: 'requestType',
              state: 'needs_input',
              code: placed.problem === 'level_not_allowed' && !fitting.length ? 'level_no_children' : placed.problem,
              value: requestType,
              display: requestType,
              options: fitting,
            }
          : { key: 'requestType', state: 'ok', value: requestType, display: requestType, options: fitting },
    );

    // The six values the process form has for its type; parents add them up from their children.
    const prefix = requestType === 'Maßnahme' ? 'action_' : 'vuln_';
    const asked = this.has(action, 'scores')
      ? Object.entries((action.overrides.scores ?? {}) as Record<string, unknown>)
      : (intent.process_scores ?? []).map(({ key, value }) => [key, value] as [string, unknown]);
    const scores: Record<string, number> = {};
    for (const [key, value] of asked) {
      if (
        key.startsWith(prefix) &&
        (PROCESS_SCORE_KEYS as readonly string[]).includes(key) &&
        Number.isInteger(value) &&
        (value as number) >= 0 &&
        (value as number) <= 4
      )
        scores[key] = value as number;
    }
    const mustHave = requestType === 'Maßnahme' || requestType === 'Schwachstelle';
    fields.push(
      mustHave && !Object.keys(scores).length
        ? { key: 'scores', state: 'needs_input', code: 'scores_missing', value: scores, params: { prefix } }
        : { key: 'scores', state: 'ok', value: scores, params: { prefix } },
    );

    const assigneeId = await this.resolveAssignee(batch, action, space?.id ?? null, fields);
    fields.push(...parentFields);
    return {
      title,
      description,
      confirmable: fields.every((f) => f.state !== 'needs_input' && f.state !== 'blocked'),
      fields,
      create: {
        kind: 'process',
        spaceId: space?.id ?? null,
        ...(pendingSpace !== null && { pendingSpace }),
        title,
        description,
        requestType: requestType ?? '',
        assigneeId,
        scores,
        hierarchyLevelId: placed.levelId,
        ...(parent?.existingId && { parentId: parent.existingId }),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Product plans and plan items (1.22, ROB-08). "Plan" here is a project plan, never the batch.
  // ---------------------------------------------------------------------------

  private async resolveProductPlan(batch: AgentResolveBatch, action: AgentResolveAction): Promise<AgentResolved> {
    const { intent } = action;
    const fields: AgentFieldView[] = [];
    const raw = stripMarkup(this.text(action, 'title') ?? intent.title).replace(/\s+/g, ' ');
    const name = cut(raw, MAX_PLAN_NAME);
    fields.push(
      !name
        ? { key: 'title', state: 'needs_input', code: 'required_missing', value: '' }
        : Array.from(raw).length > MAX_PLAN_NAME
          ? { key: 'title', state: 'check', code: 'too_long', params: { max: MAX_PLAN_NAME }, value: name }
          : { key: 'title', state: 'ok', value: name },
    );
    const description =
      cut(stripMarkup(this.has(action, 'description') ? this.text(action, 'description') : intent.description), 5000) || null;
    fields.push({ key: 'description', state: 'ok', value: description });

    const space = await this.resolveSpace(batch, action, fields);
    const pendingSpace = this.pendingSpaceOf(batch, action);
    if (!this.productPlans?.available)
      fields.push({ key: 'space', state: 'blocked', code: 'module_off', value: null, editable: false });

    const planType = this.resolvePlanType(action, fields);
    // A plan always starts as a draft: a person activates it.
    const asked = intent.status ? nameKey(intent.status) : '';
    fields.push(
      asked && !/^(draft|entwurf)$/.test(asked)
        ? { key: 'status', state: 'check', code: 'starts_as_draft', value: 'draft', said: intent.status ?? undefined, editable: false }
        : { key: 'status', state: 'ok', value: 'draft', editable: false },
    );
    const { start, end } = this.resolveSpan(batch, action, fields, false, null);
    const ownerId = await this.resolveAssignee(batch, action, space?.id ?? null, fields);

    return {
      title: name,
      description,
      confirmable: fields.every((f) => f.state !== 'needs_input' && f.state !== 'blocked'),
      fields,
      create: {
        kind: 'plan',
        spaceId: space?.id ?? null,
        ...(pendingSpace !== null && { pendingSpace }),
        name,
        description,
        planType: planType ?? 'waterfall',
        startDate: start,
        endDate: end,
        ownerId,
      },
    };
  }

  private resolvePlanType(action: AgentResolveAction, fields: AgentFieldView[]): AgentPlanType | null {
    const said = this.text(action, 'planType') ?? (action.intent as { plan_type?: string | null }).plan_type ?? null;
    const options = PLAN_TYPES.map((t) => ({ value: t, label: t }));
    if (!said) {
      fields.push({ key: 'planType', state: 'ok', value: 'waterfall', options });
      return 'waterfall';
    }
    const word = nameKey(said);
    const type: AgentPlanType | undefined = (PLAN_TYPES as readonly string[]).includes(word)
      ? (word as AgentPlanType)
      : /^(wasserfall|classic|klassisch|traditional|sequential|sequenziell)/.test(word)
        ? 'waterfall'
        : /^(scrum|kanban|sprint|agil)/.test(word)
          ? 'agile'
          : /^(hybrid)/.test(word)
            ? 'hybrid'
            : undefined;
    fields.push(
      type
        ? { key: 'planType', state: 'ok', value: type, said, options }
        : { key: 'planType', state: 'needs_input', code: 'unknown_plan_type', value: null, said, options },
    );
    return type ?? null;
  }

  private async resolvePlanItem(batch: AgentResolveBatch, action: AgentResolveAction): Promise<AgentResolved> {
    const { intent } = action;
    const extra = intent as AgentIntent & {
      item_type?: string | null;
      estimated_hours?: number | null;
      estimated_cost?: number | null;
      progress?: number | null;
    };
    const fields: AgentFieldView[] = [];
    const rawTitle = stripMarkup(this.text(action, 'title') ?? intent.title).replace(/\s+/g, ' ');
    const title = cut(rawTitle, MAX_TITLE);
    fields.push(
      !title
        ? { key: 'title', state: 'needs_input', code: 'required_missing', value: '' }
        : Array.from(rawTitle).length > MAX_TITLE
          ? { key: 'title', state: 'check', code: 'too_long', params: { max: MAX_TITLE }, value: title }
          : { key: 'title', state: 'ok', value: title },
    );
    // Cut so the stored HTML fits CreatePlanItemDto: the card shows exactly what is stored.
    const description =
      fitPlanItemText(stripMarkup(this.has(action, 'description') ? this.text(action, 'description') : intent.description)) || null;
    fields.push({ key: 'description', state: 'ok', value: description });

    // Its plan: the one of this request above it, else the one picked or named, else the space's only one.
    const above = action.dependsOn !== null ? batch.siblings.get(action.dependsOn) : undefined;
    const pendingPlan = above?.pendingPlan ?? null;
    const pendingSpace = this.pendingSpaceOf(batch, action);
    let plan: ProductPlanRow | null = null;
    let range: { start: string | null; end: string | null } = above?.range ?? { start: null, end: null };
    if (pendingPlan !== null) {
      const home = batch.siblings.get(pendingPlan);
      fields.push({ key: 'plan', state: 'ok', value: null, display: home?.title ?? '', params: { ordinal: pendingPlan }, editable: false });
      range = home?.range ?? range;
    } else if (above?.planId) {
      plan = await this.planRow(batch, above.planId);
      fields.push(
        plan
          ? { key: 'plan', state: 'ok', value: plan.id, display: planLabel(plan), editable: false }
          : { key: 'plan', state: 'needs_input', code: 'unknown_plan', value: null, editable: false },
      );
    } else {
      plan = await this.pickPlan(batch, action, fields);
    }
    if (plan) range = { start: day(plan.start_date), end: day(plan.end_date) };
    const spaceId = plan?.space_id ?? (pendingPlan !== null ? (batch.siblings.get(pendingPlan)?.spaceId ?? null) : null);
    if (plan && spaceId && !(await this.moduleSpaces(batch, 'tasks')).has(spaceId))
      fields.push({ key: 'space', state: 'blocked', code: 'module_off', value: spaceId, editable: false });

    // Its parent item: one of this request above it, else one of the plan named by key or words.
    const parentFields: AgentFieldView[] = [];
    let parentTaskId: string | null = null;
    let parentIsMilestone = false;
    if (above?.kind === 'plan_item') {
      parentFields.push({ key: 'parent', state: 'ok', value: null, params: { ordinal: action.dependsOn as number }, editable: false });
      parentIsMilestone = above.itemType === 'milestone';
    } else if (plan) {
      const wanted = this.has(action, 'parent') ? this.text(action, 'parent') : (intent.parent.key ?? intent.parent.said ?? undefined);
      if (wanted) {
        const found = await this.memo(batch, `plan-items:${plan.id}:${nameKey(wanted)}`, () =>
          (this.productPlans as AgentPlansService).findItems(plan.id, wanted),
        );
        const byId = found.find((f) => f.taskId === wanted);
        const only = byId ?? (found.length === 1 ? found[0] : undefined);
        if (only) {
          parentTaskId = only.taskId;
          parentIsMilestone = only.itemType === 'milestone';
          parentFields.push({ key: 'parent', state: 'ok', value: only.taskId, display: [only.key, only.summary].filter(Boolean).join(' ') });
        } else {
          parentFields.push({
            key: 'parent',
            state: 'needs_input',
            code: found.length ? 'ambiguous_parent' : 'parent_not_in_plan',
            value: null,
            said: wanted,
            options: found.map((f) => ({ value: f.taskId, label: f.summary, ...(f.key && { hint: f.key }) })),
          });
        }
      }
    }

    // Its type. A milestone has one date and nothing under it.
    const saidType = this.text(action, 'itemType') ?? extra.item_type ?? (intent.milestone ? 'milestone' : null);
    const typeWord = saidType ? nameKey(saidType).replace(/[\s-]+/g, '_') : 'task';
    const itemType = ((PLAN_ITEM_TYPES as readonly string[]).includes(typeWord)
      ? typeWord
      : /^(meilenstein|milestone)/.test(typeWord)
        ? 'milestone'
        : /^(phase)/.test(typeWord)
          ? 'phase'
          : /^(arbeitspaket|work_?package|package)/.test(typeWord)
            ? 'work_package'
            : 'task') as AgentPlanItemType;
    const typeOptions = PLAN_ITEM_TYPES.map((t) => ({ value: t, label: t }));
    fields.push({ key: 'itemType', state: 'ok', value: itemType, options: typeOptions });
    if (parentIsMilestone) {
      const at = parentFields.findIndex((f) => f.key === 'parent');
      parentFields[at] = { ...parentFields[at], state: 'needs_input', code: 'milestone_children' };
    }

    const { start, end } = this.resolveSpan(batch, action, fields, itemType === 'milestone', range);
    const ownerId = await this.resolveAssignee(batch, action, spaceId, fields);

    const level = intent.priority?.level ?? 'none';
    const priorityWord = this.text(action, 'priority') ?? (level !== 'none' ? level : null);
    const priority = priorityWord && (PLAN_ITEM_PRIORITIES as readonly string[]).includes(priorityWord) ? priorityWord : null;
    // A priority said that matches none is asked about, as for a task (audit 2026-11-10).
    const saidPriority = this.has(action, 'priority') ? null : intent.priority?.said;
    const options = PLAN_ITEM_PRIORITIES.map((p) => ({ value: p, label: p }));
    fields.push(
      !priority && (saidPriority || priorityWord)
        ? { key: 'priority', state: 'check', code: 'unknown_priority', value: null, options, ...(saidPriority && { said: saidPriority }) }
        : { key: 'priority', state: 'ok', value: priority, options },
    );

    const currency = plan?.currency ?? 'EUR';
    const estimatedHours = this.resolveNumber(action, fields, 'estimatedHours', extra.estimated_hours, { min: 0, max: PLAN_ITEM_MAX_HOURS });
    const estimatedCost = this.resolveNumber(action, fields, 'estimatedCost', extra.estimated_cost, { min: 0, max: PLAN_ITEM_MAX_COST, currency });
    const progress = this.resolveNumber(action, fields, 'progress', extra.progress, { min: 0, max: 100, integer: true });

    fields.push(...parentFields);
    const dependencies = await this.resolveDependencies(batch, action, fields, plan, pendingPlan, { start, end });
    return {
      title,
      description,
      confirmable: fields.every((f) => f.state !== 'needs_input' && f.state !== 'blocked'),
      fields,
      range,
      create: {
        kind: 'plan_item',
        dependencies,
        spaceId,
        ...(pendingSpace !== null && { pendingSpace }),
        planId: plan?.id ?? null,
        ...(pendingPlan !== null && { pendingPlan }),
        parentTaskId,
        name: title,
        description,
        itemType,
        startDate: start,
        endDate: end,
        ownerId,
        priority,
        estimatedHours,
        estimatedCost,
        progress,
      },
    };
  }

  /**
   * 1.22.1: an existing task into a plan. Robert never changes the task: the card shows its values
   * read-only and only the plan_tasks row is made. It goes where its own parent puts it.
   */
  private async resolvePlanLink(batch: AgentResolveBatch, action: AgentResolveAction): Promise<AgentResolved> {
    const { intent } = action;
    const fields: AgentFieldView[] = [];
    const ref = (intent as { task?: { key: string | null; said: string | null } }).task;
    const said = (this.text(action, 'task') ?? ref?.key ?? ref?.said ?? intent.title ?? '').trim();
    const key = TASK_KEY_ONLY.test(said) ? said.toUpperCase() : null;
    const task = key ? await this.linkTask(batch, key) : null;

    const above = action.dependsOn !== null ? batch.siblings.get(action.dependsOn) : undefined;
    const pendingPlan = above?.pendingPlan ?? null;
    let plan: ProductPlanRow | null = null;
    if (pendingPlan !== null) {
      const home = batch.siblings.get(pendingPlan);
      fields.push({ key: 'plan', state: 'ok', value: null, display: home?.title ?? '', params: { ordinal: pendingPlan }, editable: false });
    } else {
      plan = await this.pickPlan(batch, action, fields);
    }
    const spaceId = plan?.space_id ?? (pendingPlan !== null ? (batch.siblings.get(pendingPlan)?.spaceId ?? null) : null);

    if (!task) {
      // A task the invoker may not see is no different from one that does not exist: no title.
      fields.push({ key: 'task', state: 'needs_input', code: 'task_not_found', value: null, said, editable: false });
      return { title: key ?? said, description: null, confirmable: false, fields, create: null };
    }
    const label = `${task.key} ${task.summary}`;
    const inPlan = plan ? task.plans.includes(plan.id) : false;
    fields.push(
      spaceId && task.space_id !== spaceId
        ? { key: 'task', state: 'blocked', code: 'task_other_space', value: task.id, display: label, editable: false }
        : inPlan
          ? { key: 'task', state: 'blocked', code: 'already_in_plan', value: task.id, display: label, editable: false }
          : { key: 'task', state: 'ok', value: task.id, display: label, editable: false },
    );
    const others = await this.planNames(task.plans.filter((id) => id !== plan?.id));
    if (others.length) fields.push({ key: 'otherPlans', state: 'ok', value: null, params: { plans: others.join('; ') }, editable: false });

    // Its place: its own parent decides. Asked to go under an item it is not a child of, or a
    // subtask whose parent is not in the plan: at top level, never moved (D1, D2).
    const wantedParent = intent.parent.key ?? intent.parent.said ?? null;
    const parentInPlan = !!task.parent_task_id && !!plan && (await this.inPlan(plan.id, task.parent_task_id));
    let wantedId: string | null = null;
    if (wantedParent && plan) {
      const found = await (this.productPlans as AgentPlansService).findItems(plan.id, wantedParent);
      wantedId = found.length === 1 ? found[0].taskId : null;
    }
    if ((wantedParent && wantedId !== task.parent_task_id) || (task.parent_task_id && !parentInPlan && !!plan))
      fields.push({ key: 'placement', state: 'check', code: 'link_top_level', value: null, editable: false, ...(wantedParent && { said: wantedParent }) });
    if (task.subtasks > 0)
      fields.push({ key: 'subtasks', state: 'check', code: 'subtasks_stay_out', value: null, params: { count: task.subtasks }, editable: false });

    fields.push(
      { key: 'start', state: 'ok', value: task.start_date, editable: false },
      { key: 'end', state: 'ok', value: task.end_date, editable: false },
      { key: 'assignee', state: 'ok', value: task.assigned_to, editable: false },
      task.done
        ? { key: 'status', state: 'check', code: 'task_done', value: null, editable: false }
        : { key: 'status', state: 'ok', value: null, editable: false },
    );
    const typeWord = this.text(action, 'itemType') ?? (intent as { item_type?: string | null }).item_type ?? 'task';
    const itemType = ((PLAN_ITEM_TYPES as readonly string[]).includes(typeWord) ? typeWord : 'task') as AgentPlanItemType;
    fields.push({ key: 'itemType', state: 'ok', value: itemType, options: PLAN_ITEM_TYPES.map((t) => ({ value: t, label: t })) });

    return {
      title: task.summary,
      description: null,
      confirmable: fields.every((f) => f.state !== 'needs_input' && f.state !== 'blocked'),
      fields,
      create: {
        kind: 'plan_link',
        spaceId,
        planId: plan?.id ?? null,
        ...(pendingPlan !== null && { pendingPlan }),
        taskId: task.id,
        taskKey: task.key,
        itemType,
      },
    };
  }

  /** A task by key as the invoker sees it (view_tasks in its space), with what its card shows. */
  private linkTask(
    batch: AgentResolveBatch,
    key: string,
  ): Promise<LinkTaskRow | null> {
    return this.memo(batch, `link-task:${key}`, async () => {
      const { data } = await this.client
        .from('tasks')
        .select('id, key, summary, space_id, parent_task_id, start_date, end_date, assigned_to, status_id')
        .eq('organization_id', batch.invoker.organizationId)
        .eq('key', key)
        .maybeSingle();
      const row = data as Omit<LinkTaskRow, 'plans' | 'subtasks' | 'done'> & { status_id: string | null } | null;
      if (!row?.space_id || !(await this.canViewTasks(batch, row.space_id))) return null;
      const [plans, children, status] = await Promise.all([
        this.client.from('plan_tasks').select('plan_id').eq('task_id', row.id),
        this.client.from('tasks').select('id').eq('parent_task_id', row.id),
        row.status_id
          ? this.client.from('task_statuses').select('is_completed, category:status_categories(is_done_like)').eq('id', row.status_id).maybeSingle()
          : Promise.resolve({ data: null }),
      ]);
      const st = status.data as { is_completed?: boolean; category?: { is_done_like?: boolean } | null } | null;
      return {
        ...row,
        plans: ((plans.data ?? []) as { plan_id: string }[]).map((p) => p.plan_id),
        subtasks: ((children.data ?? []) as unknown[]).length,
        done: !!(st?.is_completed || st?.category?.is_done_like),
      };
    });
  }

  private async inPlan(planId: string, taskId: string): Promise<boolean> {
    const { data } = await this.client.from('plan_tasks').select('id').eq('plan_id', planId).eq('task_id', taskId).maybeSingle();
    return !!data;
  }

  private async planNames(ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const { data } = await this.client.from('plans').select('plan_key, name').in('id', ids);
    return ((data ?? []) as { plan_key: string | null; name: string }[]).map((p) => [p.plan_key, p.name].filter(Boolean).join(' '));
  }

  /**
   * 1.22.1: the dependencies a new plan item asked for, one row each. The words decide the type;
   * words that say none are asked about. The other end is a card of this request in the same plan
   * or an item already in it. A refused one leaves the item; dates that break one only warn.
   */
  private async resolveDependencies(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
    plan: ProductPlanRow | null,
    pendingPlan: number | null,
    own: { start: string | null; end: string | null },
  ): Promise<AgentPlanDependency[]> {
    const asked = ((action.intent as { depends?: AgentDependsIntent[] }).depends ?? []).slice(0, 10);
    const out: AgentPlanDependency[] = [];
    const options = (Object.keys(DEPENDENCY_TYPE_NAMES) as AgentDependencyType[]).map((t) => ({ value: t, label: DEPENDENCY_TYPE_NAMES[t] }));
    for (const [i, d] of asked.entries()) {
      const key = `dependency:${i}`;
      const base = { key, said: d.words || undefined };
      const chosen = this.text(action, key);
      const type = (chosen && chosen in DEPENDENCY_TYPE_NAMES ? chosen : dependencyTypeOf(d.words)) as AgentDependencyType | null;
      const thisIs = d.this_is === 'predecessor' ? 'predecessor' : 'successor';
      if (d.item && d.item === action.intent.ref) {
        fields.push({ ...base, state: 'check', code: 'dependency_self', value: null, editable: false });
        continue;
      }
      // The other end.
      let otherTaskId: string | null = null;
      let otherOrdinal: number | null = null;
      let display = d.said ?? d.key ?? '';
      if (d.ordinal !== null && d.ordinal !== undefined) {
        const sib = batch.siblings.get(d.ordinal);
        const samePlan =
          sib && (sib.kind === 'plan_item' || sib.kind === 'plan_link') &&
          ((plan && sib.planId === plan.id) || (pendingPlan !== null && sib.pendingPlan === pendingPlan));
        if (!samePlan) {
          fields.push({ ...base, state: 'check', code: 'dependency_other_plan', value: null, display, editable: false });
          continue;
        }
        otherOrdinal = d.ordinal;
        display = sib.title ?? display;
      } else {
        const wanted = d.key ?? d.said;
        // A task this same answer links into the plan, named by its key: that card is the other end.
        const linked = d.key
          ? [...batch.siblings.entries()].find(
              ([, sib]) =>
                sib.kind === 'plan_link' &&
                sib.taskKey?.toUpperCase() === d.key?.trim().toUpperCase() &&
                ((plan && sib.planId === plan.id) || (pendingPlan !== null && sib.pendingPlan === pendingPlan)),
            )
          : undefined;
        if (linked) {
          otherOrdinal = linked[0];
          display = linked[1].title ?? display;
        }
        const found = linked ? [] : plan && wanted ? await (this.productPlans as AgentPlansService).findItems(plan.id, wanted) : [];
        if (!linked && found.length !== 1) {
          fields.push({ ...base, state: 'check', code: found.length ? 'dependency_ambiguous' : 'dependency_not_in_plan', value: null, display, editable: false });
          continue;
        }
        if (!linked) {
          otherTaskId = found[0].taskId;
          display = [found[0].key, found[0].summary].filter(Boolean).join(' ');
        }
      }
      if (!type) {
        fields.push({ ...base, state: 'needs_input', code: 'dependency_type_unclear', value: null, display, options });
        continue;
      }
      const row: AgentPlanDependency = { type, thisIs, otherTaskId, otherOrdinal };
      // Dates that break it: a warning, as the human Gantt does not even warn (D5).
      const other = otherTaskId ? await this.taskDates(batch, otherTaskId) : null;
      const broken = other && breaksDependency(row, own, other);
      fields.push({
        ...base,
        state: broken ? 'check' : 'ok',
        ...(broken && { code: 'dependency_dates' }),
        value: type,
        display,
        params: { type, thisIs },
        options,
      });
      out.push(row);
    }
    return out;
  }

  private taskDates(batch: AgentResolveBatch, taskId: string): Promise<{ start: string | null; end: string | null }> {
    return this.memo(batch, `task-dates:${taskId}`, async () => {
      const { data } = await this.client.from('tasks').select('start_date, end_date').eq('id', taskId).maybeSingle();
      const row = data as { start_date: string | null; end_date: string | null } | null;
      return { start: day(row?.start_date ?? null), end: day(row?.end_date ?? null) };
    });
  }

  // ---------------------------------------------------------------------------
  // 1.23: what Robert suggests a plan lacks. One card each, on an existing plan; every card says
  // it is a suggestion and why, and is checked again at Confirm.
  // ---------------------------------------------------------------------------

  private async resolveSuggestion(batch: AgentResolveBatch, action: AgentResolveAction): Promise<AgentResolved> {
    const kind = action.kind as AgentSuggestionKind;
    const fields: AgentFieldView[] = [];
    const above = action.dependsOn !== null ? batch.siblings.get(action.dependsOn) : undefined;
    let plan: ProductPlanRow | null = null;
    if (above && (above.kind === 'plan' || above.pendingPlan !== undefined && above.pendingPlan !== null)) {
      // A plan of this same request does not exist yet: it is confirmed first, then asked again.
      fields.push({ key: 'plan', state: 'blocked', code: 'plan_first', value: null, display: above.title ?? '', editable: false });
    } else {
      plan = await this.pickPlan(batch, action, fields);
    }
    if (plan && kind === 'plan_baseline' && !(await (this.productPlans as AgentPlansService).canDelete(batch.invoker, plan))) {
      // The human baseline route needs the plan's admin level.
      const at = fields.findIndex((f) => f.key === 'plan');
      fields[at] = { ...fields[at], state: 'blocked', code: 'no_baseline_right' };
      plan = null;
    }
    // The model names its sources by run handles ([m1], [F2], @P3): they mean nothing on the card.
    const reason =
      cut(
        stripMarkup(action.intent.reason ?? '')
          .replace(/\s?[([](?:@?[PmFTW]\d+(?:,\s*)?)+[)\]]/g, '')
          .replace(/@P\d+\b/g, '')
          .replace(/\s+/g, ' ')
          .trim(),
        240,
      ) || null;
    if (reason) fields.push({ key: 'reason', state: 'ok', value: reason, editable: false });

    const out =
      kind === 'plan_dependency'
        ? await this.resolveSuggestedDependency(batch, action, fields, plan, reason)
        : kind === 'plan_dates'
          ? await this.resolveSuggestedDates(batch, action, fields, plan)
          : kind === 'plan_risk'
            ? await this.resolveSuggestedRisk(batch, action, fields, plan, reason)
            : kind === 'plan_stakeholder'
              ? await this.resolveSuggestedStakeholder(batch, action, fields, plan, reason)
              : await this.resolveSuggestedBaseline(batch, action, fields, plan);
    const confirmable = !!out.create && fields.every((f) => f.state !== 'needs_input' && f.state !== 'blocked');
    return { title: out.title, description: out.description ?? null, confirmable, fields, create: confirmable ? out.create : null };
  }

  /**
   * 1.23: the items a "suggest dates" request is about: the keys it names, or every item of the
   * plan without dates (Robert's own first). Null when the plan can't be told yet: the card asks.
   */
  async datesTargets(batch: AgentResolveBatch, intent: AgentIntent): Promise<{ planId: string; keys: string[]; items: number } | null> {
    const plan = await this.pickPlan(batch, { kind: 'plan_dates', intent: intent as AgentStoredIntent, overrides: {}, dependsOn: null }, []);
    if (!plan) return null;
    const g = await this.planGraph(batch, plan.id);
    const named = ((intent as { dates_for?: string[] }).dates_for ?? []).map((k) => k.trim().toUpperCase()).filter(Boolean);
    const keys = named.length
      ? [...new Set(named)]
      : g.items
          .filter((i) => !i.start_date && !i.end_date && i.key)
          .sort((a, b) => Number(b.robert) - Number(a.robert))
          .map((i) => i.key as string);
    return { planId: plan.id, keys, items: g.items.length };
  }

  /** One plan's items and dependencies, one read per plan and batch (agent_plan_graph). */
  private planGraph(batch: AgentResolveBatch, planId: string): Promise<PlanGraph> {
    return this.memo(batch, `plan-graph:${planId}`, async () => {
      const { data, error } = await this.client.rpc('agent_plan_graph', {
        p_organization_id: batch.invoker.organizationId,
        p_plan_id: planId,
      });
      if (error) throw new Error(error.message);
      const g = (data ?? {}) as { items?: PlanGraphItem[]; edges?: PlanGraphEdge[] };
      return { items: g.items ?? [], edges: g.edges ?? [] };
    });
  }

  /** The names already in a plan's risks or stakeholders (D4), trimmed and in any case. */
  private planRowNames(batch: AgentResolveBatch, table: 'plan_risks' | 'plan_stakeholders', planId: string): Promise<Set<string>> {
    return this.memo(batch, `${table}:${planId}`, async () => {
      const { data, error } = await this.client.from(table).select('name').eq('plan_id', planId).limit(2000);
      if (error) throw new Error(error.message);
      return new Set(((data ?? []) as { name: string }[]).map((r) => nameKey(r.name)));
    });
  }

  /**
   * The organization's holidays (its default holiday scheme, when it has one): fixed days every
   * year and one-off days, over the years a plan may span.
   */
  private orgHolidays(batch: AgentResolveBatch): Promise<{ days: Set<string>; calendar: boolean }> {
    return this.memo(batch, 'org-holidays', async () => {
      const days = new Set<string>();
      const { data: schemes } = await this.client
        .from('holiday_schemes')
        .select('id')
        .eq('organization_id', batch.invoker.organizationId)
        .eq('is_default', true)
        .eq('is_active', true)
        .limit(1);
      const scheme = ((schemes ?? []) as { id: string }[])[0];
      if (!scheme) return { days, calendar: false };
      const { data } = await this.client
        .from('holiday_scheme_days')
        .select('recurrence, month, day, holiday_date, duration_days')
        .eq('scheme_id', scheme.id)
        .limit(1000);
      const year = batch.now.getUTCFullYear();
      const add = (first: string, n: number) => {
        for (let i = 0; i < Math.max(1, n); i++) days.add(new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
      };
      for (const d of (data ?? []) as { recurrence: string; month: number | null; day: number | null; holiday_date: string | null; duration_days: number | null }[]) {
        if (d.recurrence === 'fixed_annual' && d.month && d.day)
          for (let y = year - 1; y <= year + 3; y++) add(`${y}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`, d.duration_days ?? 1);
        else if (d.holiday_date) add(d.holiday_date.slice(0, 10), d.duration_days ?? 1);
      }
      return { days, calendar: true };
    });
  }

  /** An item of the plan as named: chosen on the card, by key, by exact name, or one name that contains it. */
  private graphItem(items: PlanGraphItem[], chosen: string | undefined, ref?: { key?: string | null; said?: string | null } | null) {
    if (chosen) return items.filter((i) => i.task_id === chosen);
    const key = ref?.key?.trim().toLowerCase();
    if (key) {
      const byKey = items.filter((i) => i.key?.toLowerCase() === key);
      if (byKey.length) return byKey;
    }
    const said = ref?.said ? nameKey(ref.said) : key ?? '';
    if (!said) return [];
    const exact = items.filter((i) => nameKey(i.summary) === said);
    return exact.length ? exact : items.filter((i) => nameKey(i.summary).includes(said)).slice(0, 6);
  }

  private itemOptions(items: PlanGraphItem[]): AgentFieldOption[] {
    return items.slice(0, 100).map((i) => ({ value: i.task_id, label: i.summary, ...(i.key && { hint: i.key }) }));
  }

  private async resolveSuggestedDependency(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
    plan: ProductPlanRow | null,
    reason: string | null,
  ): Promise<SuggestionOut> {
    const intent = action.intent as AgentIntent & { predecessor?: EndRef; successor?: EndRef; dependency_type?: string };
    const title = [intent.predecessor?.key ?? intent.predecessor?.said, intent.successor?.key ?? intent.successor?.said]
      .map((v) => v ?? '?')
      .join(' → ');
    if (!plan) return { title, create: null };
    const g = await this.planGraph(batch, plan.id);
    const options = this.itemOptions(g.items);
    const end = (which: 'predecessor' | 'successor') => {
      const ref = intent[which];
      const hits = this.graphItem(g.items, this.text(action, which), ref);
      const said = ref?.key ?? ref?.said ?? undefined;
      if (hits.length !== 1) {
        fields.push({ key: which, state: 'needs_input', code: hits.length ? 'dependency_ambiguous' : 'dependency_not_in_plan', value: null, ...(said && { said }), options: hits.length ? this.itemOptions(hits) : options });
        return null;
      }
      fields.push({ key: which, state: 'ok', value: hits[0].task_id, display: itemLabel(hits[0]), options });
      return hits[0];
    };
    const pred = end('predecessor');
    const succ = end('successor');
    const typeOptions = (Object.keys(DEPENDENCY_TYPE_NAMES) as AgentDependencyType[]).map((t) => ({ value: t, label: DEPENDENCY_TYPE_NAMES[t] }));
    const chosen = this.text(action, 'dependencyType') ?? intent.dependency_type ?? null;
    const type = chosen && chosen in DEPENDENCY_TYPE_NAMES ? (chosen as AgentDependencyType) : null;
    fields.push(
      type
        ? { key: 'dependencyType', state: 'ok', value: type, options: typeOptions }
        : { key: 'dependencyType', state: 'needs_input', code: 'dependency_type_unclear', value: null, options: typeOptions },
    );
    const label = pred && succ ? `${itemLabel(pred)} → ${itemLabel(succ)}` : title;
    if (!pred || !succ || !type) return { title: label, create: null };
    if (pred.task_id === succ.task_id) {
      fields.push({ key: 'dependency', state: 'blocked', code: 'dependency_self', value: null, editable: false });
      return { title: label, create: null };
    }
    // Two items already linked (either way, any type) are never suggested again.
    if (g.edges.some((e) => (e.source === pred.task_id && e.target === succ.task_id) || (e.source === succ.task_id && e.target === pred.task_id))) {
      fields.push({ key: 'dependency', state: 'blocked', code: 'dependency_exists', value: null, editable: false });
      return { title: label, create: null };
    }
    // A cycle with what exists and with the earlier suggestions of this request: refused, the others stay.
    const edges = [
      ...g.edges.map((e) => [e.source, e.target] as const),
      ...[...batch.siblings.values()].filter((sib) => sib.kind === 'plan_dependency' && sib.planId === plan.id && sib.edge).map((sib) => [sib.edge!.source, sib.edge!.target] as const),
    ];
    if (reaches(edges, succ.task_id, pred.task_id)) {
      fields.push({ key: 'dependency', state: 'blocked', code: 'dependency_cycle', value: null, editable: false });
      return { title: label, create: null };
    }
    const broken = breaksDependency(
      { type, thisIs: 'successor', otherTaskId: pred.task_id, otherOrdinal: null },
      { start: day(succ.start_date), end: day(succ.end_date) },
      { start: day(pred.start_date), end: day(pred.end_date) },
    );
    fields.push(broken
      ? { key: 'dependency', state: 'check', code: 'dependency_dates', value: type, editable: false }
      : { key: 'dependency', state: 'ok', value: type, editable: false });
    return {
      title: label,
      create: { kind: 'plan_dependency', spaceId: plan.space_id, planId: plan.id, reason, sourceTaskId: pred.task_id, targetTaskId: succ.task_id, type },
    };
  }

  private async resolveSuggestedDates(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
    plan: ProductPlanRow | null,
  ): Promise<SuggestionOut> {
    const ref = (action.intent as { task?: { key: string | null; said: string | null } }).task;
    const said = ref?.key ?? ref?.said ?? '';
    if (!plan) return { title: said, create: null };
    const g = await this.planGraph(batch, plan.id);
    const hits = this.graphItem(g.items, undefined, ref);
    if (hits.length !== 1) {
      fields.push({ key: 'item', state: 'needs_input', code: 'task_not_found', value: null, said, editable: false });
      return { title: said, create: null };
    }
    const it = hits[0];
    fields.push({ key: 'item', state: 'ok', value: it.task_id, display: itemLabel(it), editable: false });
    const typeOf = new Map(Object.entries(DEPENDENCY_TYPE_NAMES).map(([k, v]) => [v.toLowerCase(), k as AgentDependencyType]));
    const cardEdges: DateEdge[] = [...batch.siblings.entries()]
      .filter(([, sib]) => sib.kind === 'plan_dependency' && sib.planId === plan.id && sib.edge)
      .map(([ordinal, sib]) => ({ source: sib.edge!.source, target: sib.edge!.target, type: sib.edge!.type, card: ordinal }));
    // A card of this answer that was confirmed first is also a row now: the card stands for it, so
    // the dates and their source read the same at Confirm as on the card (no second edge, no 409).
    const byCard = new Set(cardEdges.map((e) => `${e.source}>${e.target}`));
    const edges: DateEdge[] = [
      ...g.edges.flatMap((e) => {
        const type = typeOf.get(e.type.toLowerCase());
        return type && !byCard.has(`${e.source}>${e.target}`) ? [{ source: e.source, target: e.target, type, card: null }] : [];
      }),
      ...cardEdges,
    ];
    const items: DateItem[] = g.items.map((i) => ({
      taskId: i.task_id,
      key: i.key,
      summary: i.summary,
      itemType: i.item_type,
      start: day(i.start_date),
      end: day(i.end_date),
      duration: i.duration,
      estimatedMinutes: i.estimated_time,
      robert: i.robert,
    }));
    const holidays = await this.orgHolidays(batch);
    const sug = suggestDates(items, edges, { start: day(plan.start_date), end: day(plan.end_date) }, holidays.days).get(it.task_id);
    const title = itemLabel(it);
    if (!sug) return { title, create: null };
    const shown = { start: sug.start, end: sug.end };
    fields.push({ key: 'source', state: 'ok', value: sug.sources as unknown as DateSource[], params: { holidays: holidays.calendar ? 1 : 0 }, editable: false });
    if (sug.state === 'has_dates') {
      fields.push({ key: 'dates', state: 'blocked', code: 'has_dates', value: null, params: { start: day(it.start_date) ?? '', end: day(it.end_date) ?? '' }, editable: false });
      return { title, create: null };
    }
    if (sug.state === 'nothing') {
      fields.push({ key: 'dates', state: 'blocked', code: 'nothing_to_base', value: null, editable: false });
      return { title, create: null };
    }
    if (sug.state === 'person') {
      // D3: a person's item is never dated by Robert; the card shows what he would suggest.
      fields.push(
        { key: 'start', state: 'ok', value: shown.start, editable: false },
        { key: 'end', state: 'ok', value: shown.end, editable: false },
        { key: 'dates', state: 'blocked', code: 'person_item', value: null, editable: false },
      );
      return { title, create: null };
    }
    // Robert's own item: the dates may be changed on the card; what is confirmed is what is written.
    const start = this.has(action, 'start') ? strictDay(action.overrides.start) : shown.start;
    const end = it.item_type === 'milestone' ? start : this.has(action, 'end') ? strictDay(action.overrides.end) : shown.end;
    fields.push(
      start
        ? { key: 'start', state: 'ok', value: start }
        : { key: 'start', state: 'needs_input', code: sug.state === 'needs_start' && !this.has(action, 'start') ? 'start_needed' : 'invalid_date', value: null },
      end
        ? { key: 'end', state: 'ok', value: end, editable: it.item_type !== 'milestone' }
        : { key: 'end', state: 'needs_input', code: sug.state === 'needs_end' && !this.has(action, 'end') ? 'end_needed' : 'invalid_date', value: null },
    );
    if (start && end && end < start) {
      fields.push({ key: 'dates', state: 'needs_input', code: 'end_before_start', value: null, editable: false });
      return { title, create: null };
    }
    const range = { start: day(plan.start_date), end: day(plan.end_date) };
    if (start && end && ((range.start && start < range.start) || (range.end && end > range.end)))
      fields.push({ key: 'range', state: 'check', code: 'outside_plan_range', value: null, params: { start: range.start ?? '', end: range.end ?? '' }, editable: false });
    if (sug.cards.length)
      fields.push({ key: 'waits', state: 'check', code: 'waits_for_card', value: sug.cards, params: { cards: sug.cards.join(', ') }, editable: false });
    if (!start || !end) return { title, create: null };
    const duration = it.item_type === 'milestone' ? 0 : Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 86_400_000));
    return { title, create: { kind: 'plan_dates', spaceId: plan.space_id, planId: plan.id, reason: null, taskId: it.task_id, start, end, duration } };
  }

  /** A whole number on a scale, as the human form allows; none said: the form's default, shown as such. */
  private scale(action: AgentResolveAction, fields: AgentFieldView[], key: string, said: number | null | undefined, ok: (n: unknown) => boolean, fallback: number, max: number): number | null {
    const raw = this.has(action, key) ? action.overrides[key] : said;
    const options = Array.from({ length: max }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }));
    if (raw === null || raw === undefined) {
      fields.push({ key, state: 'check', code: 'default_value', value: fallback, options, advisory: true });
      return fallback;
    }
    const n = typeof raw === 'string' ? Number(raw) : raw;
    if (!ok(n)) {
      fields.push({ key, state: 'needs_input', code: 'out_of_scale', value: null, params: { min: 1, max }, said: String(raw), options });
      return null;
    }
    fields.push({ key, state: 'ok', value: n, options });
    return n as number;
  }

  /** A text field of a suggestion: plain text, cut to what the human form allows. */
  private plainField(action: AgentResolveAction, fields: AgentFieldView[], key: string, said: string | null | undefined, max: number): string | null {
    const raw = stripMarkup(this.has(action, key) ? this.text(action, key) : said).trim();
    const value = cut(raw, max) || null;
    fields.push(raw.length > max ? { key, state: 'check', code: 'too_long', params: { max }, value } : { key, state: 'ok', value });
    return value;
  }

  private suggestionName(action: AgentResolveAction, fields: AgentFieldView[], max: number, missing: AgentFieldCode = 'required_missing'): string {
    const raw = stripMarkup(this.text(action, 'title') ?? action.intent.title).replace(/\s+/g, ' ').trim();
    const name = cut(raw, max);
    fields.push(
      !name
        ? { key: 'title', state: 'needs_input', code: missing, value: '' }
        : raw.length > max
          ? { key: 'title', state: 'check', code: 'too_long', params: { max }, value: name }
          : { key: 'title', state: 'ok', value: name },
    );
    return name;
  }

  private async resolveSuggestedRisk(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
    plan: ProductPlanRow | null,
    reason: string | null,
  ): Promise<SuggestionOut> {
    const risk = (action.intent as { risk?: RiskIntent }).risk;
    const name = this.suggestionName(action, fields, 500);
    if (plan && name && (await this.planRowNames(batch, 'plan_risks', plan.id)).has(nameKey(name))) {
      const at = fields.findIndex((f) => f.key === 'title');
      fields[at] = { ...fields[at], state: 'blocked', code: 'same_name_in_plan' };
    }
    const description = cut(stripMarkup(this.has(action, 'description') ? this.text(action, 'description') : action.intent.description).trim(), 10_000) || null;
    fields.push({ key: 'description', state: 'ok', value: description });
    const typeWord = this.text(action, 'riskType') ?? risk?.risk_type ?? 'risk';
    const riskType = generatedRiskSchema.shape.risk_type.safeParse(typeWord).success ? (typeWord as 'risk' | 'opportunity') : 'risk';
    fields.push({ key: 'riskType', state: 'ok', value: riskType, options: [{ value: 'risk', label: 'risk' }, { value: 'opportunity', label: 'opportunity' }] });
    const category = this.plainField(action, fields, 'category', risk?.category, 100);
    const scaleOk = (schema: { safeParse: (v: unknown) => { success: boolean } }) => (n: unknown) => typeof n === 'number' && schema.safeParse(n).success;
    const probability = this.scale(action, fields, 'probability', risk?.probability, scaleOk(generatedRiskSchema.shape.probability), 3, 5);
    const impact = this.scale(action, fields, 'impact', risk?.impact, scaleOk(generatedRiskSchema.shape.impact), 3, 5);
    const mitigation = this.plainField(action, fields, 'mitigation', risk?.mitigation, 2000);
    const contingency = this.plainField(action, fields, 'contingency', risk?.contingency, 2000);
    // The owner, if one was named: an active member of the plan's space, otherwise the card asks.
    const ownerId = plan ? await this.resolveAssignee(batch, action, plan.space_id, fields) : null;
    if (!plan || !name || probability === null || impact === null) return { title: name, description, create: null };
    return {
      title: name,
      description,
      create: { kind: 'plan_risk', spaceId: plan.space_id, planId: plan.id, reason, name, description, riskType, category, probability, impact, mitigation, contingency, ownerId },
    };
  }

  private async resolveSuggestedStakeholder(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
    plan: ProductPlanRow | null,
    reason: string | null,
  ): Promise<SuggestionOut> {
    const sh = (action.intent as { stakeholder?: StakeholderIntent }).stakeholder;
    const name = this.suggestionName(action, fields, 255);
    if (plan && name && (await this.planRowNames(batch, 'plan_stakeholders', plan.id)).has(nameKey(name))) {
      const at = fields.findIndex((f) => f.key === 'title');
      fields[at] = { ...fields[at], state: 'blocked', code: 'same_name_in_plan' };
    }
    const role = this.plainField(action, fields, 'role', sh?.role, 255);
    const organization = this.plainField(action, fields, 'organization', sh?.organization, 255);
    const emailWord = (this.has(action, 'email') ? this.text(action, 'email') : sh?.email)?.trim() || null;
    const email = emailWord && generatedStakeholderSchema.shape.email.safeParse(emailWord).success ? emailWord : null;
    fields.push(emailWord && !email ? { key: 'email', state: 'check', code: 'invalid_email', value: null, said: emailWord } : { key: 'email', state: 'ok', value: email });
    const scaleOk = (schema: { safeParse: (v: unknown) => { success: boolean } }) => (n: unknown) => typeof n === 'number' && schema.safeParse(n).success;
    const power = this.scale(action, fields, 'power', sh?.power, scaleOk(generatedStakeholderSchema.shape.power_level), 5, 10);
    const interest = this.scale(action, fields, 'interest', sh?.interest, scaleOk(generatedStakeholderSchema.shape.interest_level), 5, 10);
    const attitudeWord = (this.has(action, 'attitude') ? this.text(action, 'attitude') : sh?.attitude)?.trim().toLowerCase() || null;
    const attitudeOptions = ['supportive', 'neutral', 'resistant'].map((a) => ({ value: a, label: a }));
    const attitude = attitudeWord && generatedStakeholderSchema.shape.attitude.safeParse(attitudeWord).success
      ? (attitudeWord as AgentPlanStakeholderPlan['attitude'])
      : null;
    fields.push(
      attitudeWord && !attitude
        ? { key: 'attitude', state: 'needs_input', code: 'out_of_scale', value: null, said: attitudeWord, options: attitudeOptions }
        : { key: 'attitude', state: 'ok', value: attitude, options: attitudeOptions },
    );
    const engagement = this.plainField(action, fields, 'engagement', sh?.engagement, 1000);
    // A user of the organization: matched to them when it is certain, and they work in the plan's
    // space. Anyone else stays a name only (never a guess).
    const userId = plan ? await this.stakeholderUser(batch, action, plan.space_id, fields) : null;
    if (!plan || !name || power === null || interest === null || (attitudeWord && !attitude)) return { title: name, create: null };
    return {
      title: name,
      create: { kind: 'plan_stakeholder', spaceId: plan.space_id, planId: plan.id, reason, name, role, organization, email, power, interest, attitude, engagement, linkedUserId: userId },
    };
  }

  /** The person a stakeholder is: a participant handle or chosen on the card, else one exact name match. */
  private async stakeholderUser(batch: AgentResolveBatch, action: AgentResolveAction, spaceId: string, fields: AgentFieldView[]): Promise<string | null> {
    const { assignee } = action.intent;
    if (this.has(action, 'assignee') || assignee.user_id || assignee.is_requester)
      return this.resolveAssignee(batch, action, spaceId, fields);
    const said = (assignee.said ?? action.intent.title ?? '').trim();
    const matches = said
      ? (await this.memo(batch, `find:${nameKey(said)}`, () => this.runs.findMembers(batch.invoker.organizationId, said, MAX_PEOPLE))).filter((m) => m.exact)
      : [];
    if (matches.length === 1 && (await this.isSpaceMember(batch, matches[0].user_id, spaceId))) {
      fields.push({ key: 'assignee', state: 'ok', value: matches[0].user_id, display: matches[0].full_name || matches[0].email || '' });
      return matches[0].user_id;
    }
    fields.push({ key: 'assignee', state: 'check', code: 'name_only', value: null, advisory: true });
    return null;
  }

  private async resolveSuggestedBaseline(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
    plan: ProductPlanRow | null,
  ): Promise<SuggestionOut> {
    // D6: a baseline is named by the person, never by Robert.
    const name = this.suggestionName(action, fields, 255, 'baseline_name');
    if (!plan) return { title: name, create: null };
    const items = (await this.planGraph(batch, plan.id)).items.length;
    fields.push({ key: 'items', state: 'ok', value: items, editable: false });
    if (!name) return { title: name, create: null };
    return { title: name, create: { kind: 'plan_baseline', spaceId: plan.space_id, planId: plan.id, reason: null, name, items } };
  }

  /** Plans the invoker may add to, once per batch. */
  private editablePlans(batch: AgentResolveBatch): Promise<ProductPlanRow[]> {
    return this.memo(batch, 'editable-plans', async () => {
      if (!(await this.moduleOn(batch, 'plans'))) return [];
      const enabled = await this.moduleSpaces(batch, 'plans');
      return (await this.allEditablePlans(batch)).filter((r) => enabled.has(r.space_id));
    });
  }

  /** Also those in spaces with plans switched off: only to say why one can't be used. */
  private viewablePlans(batch: AgentResolveBatch): Promise<ProductPlanRow[]> {
    return this.memo(batch, 'viewable-plans', async () =>
      this.productPlans?.available ? this.productPlans.editablePlans(batch.invoker, null, 'view') : [],
    );
  }

  /** Also those in spaces with plans switched off: only to say why one can't be used. */
  private allEditablePlans(batch: AgentResolveBatch): Promise<ProductPlanRow[]> {
    return this.memo(batch, 'editable-plans-all', async () =>
      this.productPlans?.available ? this.productPlans.editablePlans(batch.invoker) : [],
    );
  }

  private planRow(batch: AgentResolveBatch, id: string): Promise<ProductPlanRow | null> {
    return this.memo(batch, `plan:${id}`, async () => (UUID.test(id) ? ((await this.productPlans?.planById(batch.invoker, id)) ?? null) : null));
  }

  /**
   * The plan named or picked (BR-1, G4): by key or name among the plans the invoker may edit. In a
   * space channel with exactly one active plan they may edit, that one when none is named. Never a
   * guess: several or none give a picker.
   */
  private async pickPlan(batch: AgentResolveBatch, action: AgentResolveAction, fields: AgentFieldView[]): Promise<ProductPlanRow | null> {
    const editable = await this.editablePlans(batch);
    const open = editable.filter((p) => !p.is_archived && p.status !== 'archived');
    const options = open.slice(0, MAX_PLAN_OPTIONS).map((p) => ({ value: p.id, label: p.name, ...(p.plan_key && { hint: p.plan_key }) }));
    const said = action.intent.plan?.trim() || undefined;
    const ask = (code: AgentFieldCode, state: AgentFieldState = 'needs_input', extra: Partial<AgentFieldView> = {}) => {
      fields.push({ key: 'plan', state, code, value: null, ...(said && { said }), options, ...extra });
      return null;
    };

    let chosen: ProductPlanRow | undefined;
    if (this.has(action, 'plan')) {
      const id = action.overrides.plan;
      const row = typeof id === 'string' ? await this.planRow(batch, id) : null;
      if (!row) return ask('unknown_plan');
      chosen = row;
    } else if (said) {
      const word = nameKey(said);
      const bare = word.replace(/\b(the|der|die|das|plan|projektplan|project plan)\b/g, ' ').replace(/\s+/g, ' ').trim();
      const byKey = editable.filter((p) => p.plan_key && nameKey(p.plan_key) === word);
      const byName = editable.filter((p) => nameKey(p.name) === word || (bare && nameKey(p.name) === bare));
      const loose = editable.filter((p) => bare && nameKey(p.name).includes(bare));
      const hits = byKey.length ? byKey : byName.length ? byName : loose;
      if (hits.length > 1)
        return ask('ambiguous_plan', 'needs_input', {
          options: hits.slice(0, MAX_PLAN_OPTIONS).map((p) => ({ value: p.id, label: p.name, ...(p.plan_key && { hint: p.plan_key }) })),
        });
      chosen = hits[0];
      if (!chosen) {
        const named = (p: ProductPlanRow) =>
          (p.plan_key && nameKey(p.plan_key) === word) || nameKey(p.name) === word || (bare && nameKey(p.name) === bare);
        // A plan they may edit, in a space where plans are switched off: say that, not "not found".
        const off = (await this.allEditablePlans(batch)).find(named);
        if (off) {
          fields.push({ key: 'plan', state: 'blocked', code: 'module_off', value: off.id, display: planLabel(off), said, options });
          return null;
        }
        // One they may only look at: they can see it exists, so saying why reveals nothing.
        const seen = (await this.viewablePlans(batch)).find(named);
        if (seen) {
          fields.push({ key: 'plan', state: 'blocked', code: 'no_edit_plan', value: seen.id, display: planLabel(seen), said, options });
          return null;
        }
        return ask('unknown_plan');
      }
    } else {
      const here =
        batch.conversation.kind === 'space' ? open.filter((p) => p.space_id === batch.conversation.space_id) : [];
      const active = here.filter((p) => p.status === 'active');
      chosen = active.length === 1 ? active[0] : here.length === 1 ? here[0] : undefined;
      if (!chosen) return ask(options.length ? 'plan_required' : 'unknown_plan');
    }

    const shown = { value: chosen.id, display: planLabel(chosen), ...(said && { said }), options };
    if (!editable.some((p) => p.id === chosen.id)) {
      fields.push({ key: 'plan', state: 'blocked', code: 'no_edit_plan', ...shown });
      return null;
    }
    if (chosen.is_archived || chosen.status === 'archived') {
      fields.push({ key: 'plan', state: 'blocked', code: 'plan_archived', ...shown });
      return null;
    }
    if (chosen.status === 'completed' || chosen.status === 'on_hold') {
      fields.push({ key: 'plan', state: 'check', code: 'plan_state', params: { status: chosen.status }, ...shown });
      return chosen;
    }
    fields.push({ key: 'plan', state: 'ok', ...shown });
    return chosen;
  }

  /**
   * Start and end, as said, in the invoker's timezone (EC-B9). End before start stops Confirm
   * (AC-2); outside the plan's range only warns (BR-2). A milestone has exactly one date.
   */
  private resolveSpan(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
    milestone: boolean,
    range: { start: string | null; end: string | null } | null,
  ): { start: string | null; end: string | null } {
    const ctx = { timezone: batch.timezone, now: batch.now };
    const today = calendarDays(batch.timezone, batch.now, 1)[0].date;
    const read = (key: 'start' | 'end'): { value: string | null; said?: string; bad: boolean } => {
      const date = (action.intent as unknown as Record<string, { said: string | null; iso: string | null } | undefined>)[key];
      const said = date?.said ?? undefined;
      if (this.has(action, key)) {
        const raw = action.overrides[key];
        const value = raw === null ? null : strictDay(raw);
        return { value, said, bad: raw !== null && !value };
      }
      const value = (said ? resolveDateWords(said, ctx) : null) ?? strictDay(date?.iso);
      return { value, said, bad: !value && !!(said || date?.iso) };
    };
    let start = read('start');
    let end = read('end');
    if (milestone) {
      const one = start.value ?? end.value;
      const two = start.value && end.value && start.value !== end.value;
      if (!one || two || start.bad || end.bad) {
        fields.push({ key: 'start', state: 'needs_input', code: 'milestone_one_date', value: start.value, ...(start.said && { said: start.said }) });
        fields.push({ key: 'end', state: 'ok', value: null, editable: false });
        return { start: null, end: null };
      }
      start = { value: one, bad: false, said: start.said ?? end.said };
      end = { value: one, bad: false };
    }
    for (const [key, d] of [['start', start], ['end', end]] as const) {
      const base = { key, ...(d.said && { said: d.said }) };
      const outside =
        range && d.value && ((range.start && d.value < range.start) || (range.end && d.value > range.end));
      fields.push(
        d.bad
          ? { ...base, state: 'needs_input', code: 'invalid_date', value: null }
          : key === 'end' && start.value && end.value && end.value < start.value
            ? { ...base, state: 'needs_input', code: 'end_before_start', value: d.value, params: { start: start.value } }
            : outside
              ? { ...base, state: 'check', code: 'outside_plan_range', value: d.value, params: { start: range?.start ?? '', end: range?.end ?? '' } }
              : d.value && d.value < today
                ? { ...base, state: 'check', code: 'date_in_past', value: d.value }
                : { ...base, state: 'ok', value: d.value },
      );
    }
    return { start: start.bad ? null : start.value, end: end.bad ? null : end.value };
  }

  /** A number the model or the invoker gave; anything else is a question, never a guess. */
  private resolveNumber(
    action: AgentResolveAction,
    fields: AgentFieldView[],
    key: string,
    fromModel: number | null | undefined,
    rule: { min: number; max?: number; integer?: boolean; currency?: string },
  ): number | null {
    const raw = this.has(action, key) ? action.overrides[key] : (fromModel ?? null);
    const params = rule.currency ? { currency: rule.currency } : undefined;
    if (raw === null || raw === undefined) {
      fields.push({ key, state: 'ok', value: null, ...(params && { params }) });
      return null;
    }
    const n = typeof raw === 'number' ? raw : Number.NaN;
    const fine =
      Number.isFinite(n) && n >= rule.min && (rule.max === undefined || n <= rule.max) && (!rule.integer || Number.isInteger(n));
    fields.push(
      fine
        ? { key, state: 'ok', value: n, ...(params && { params }) }
        : { key, state: 'needs_input', code: 'invalid_number', value: null, params: { min: rule.min, ...(rule.max !== undefined && { max: rule.max }), ...params } },
    );
    return fine ? n : null;
  }

  /** The hierarchy that applies: the space's own, a new space has the default. */
  private levelsOf(batch: AgentResolveBatch, spaceId: string | null): Promise<ProcessLevel[]> {
    return this.memo(batch, `process-levels:${spaceId ?? 'default'}`, async () => {
      if (!this.processHierarchy) return [];
      const config = spaceId
        ? (await this.processHierarchy.getConfig(batch.invoker.organizationId, spaceId)).config
        : await this.processHierarchy.getDefaultConfig();
      return config.levels as ProcessLevel[];
    });
  }

  /** The default ladder for the prompt: the model does not know yet which space a plan goes in. */
  async processLevels(): Promise<ProcessLevel[]> {
    return ((await this.processHierarchy?.getDefaultConfig())?.levels ?? []) as ProcessLevel[];
  }

  /** The process this one goes under: of this request, or an existing one of the same space. */
  private async parentProcess(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string | null,
    fields: AgentFieldView[],
  ): Promise<{ levelId: string | null; requestType: string; existingId?: string } | null> {
    const main = action.dependsOn !== null ? batch.siblings.get(action.dependsOn) : undefined;
    if (main?.kind === 'process') {
      fields.push({ key: 'process', state: 'ok', value: null, params: { ordinal: action.dependsOn as number }, editable: false });
      return { levelId: main.hierarchyLevelId ?? null, requestType: main.requestType ?? '' };
    }
    const key = action.intent.parent?.key?.trim().toUpperCase();
    if (!key) return null;
    // Scoped to the organization and the space: a key elsewhere is the same as no such key.
    const { data } = spaceId
      ? await this.client
          .from('business_processes')
          .select('id, key, title, request_type, hierarchy_level_id')
          .eq('organization_id', batch.invoker.organizationId)
          .eq('space_id', spaceId)
          .eq('key', key)
          .maybeSingle()
      : { data: null };
    const row = data as { id: string; key: string; title: string; request_type: string; hierarchy_level_id: string | null } | null;
    if (!row) {
      fields.push({ key: 'process', state: 'needs_input', code: 'parent_not_found', value: null, said: key, editable: false });
      return null;
    }
    fields.push({ key: 'process', state: 'ok', value: row.id, display: `${row.key} ${row.title}`, editable: false });
    return { levelId: row.hierarchy_level_id, requestType: row.request_type, existingId: row.id };
  }

  private async resolveMember(batch: AgentResolveBatch, action: AgentResolveAction): Promise<AgentResolved> {
    const kind = action.kind as AgentMemberKind;
    const { intent } = action;
    const fields: AgentFieldView[] = [];
    const space = await this.resolveSpace(batch, action, fields);
    const pendingSpace = this.pendingSpaceOf(batch, action);

    // The person, with the assignee's matching: a name that fits two people always asks.
    const asPerson: AgentResolveAction = {
      ...action,
      intent: {
        ...intent,
        assignee: {
          ...(intent.member ?? { said: null, participant: null, is_requester: false }),
          user_id: (intent.member as { user_id?: string | null } | undefined)?.user_id ?? null,
        },
      },
      overrides: 'member' in action.overrides ? { assignee: action.overrides.member } : {},
    };
    const people: AgentFieldView[] = [];
    const userId = await this.resolveAssignee(batch, asPerson, null, people);
    const row = people[0];
    if (row) {
      const missing = !userId && row.state === 'ok';
      fields.push({
        ...row,
        key: 'member',
        ...(missing && { state: 'needs_input' as const, code: 'unknown_person' as const }),
        ...(row.code === 'assignee_not_in_conversation' && { state: 'ok' as const, code: undefined, advisory: undefined }),
      });
    }

    const wantedRole = this.text(action, 'role') ?? intent.member_role ?? null;
    const role = SPACE_ROLES.find((r) => r === wantedRole) ?? null;
    const roleOptions = SPACE_ROLES.map((r) => ({ value: r, label: r }));
    if (kind === 'space_member_role' || kind === 'space_member_add') {
      const effective = role ?? (kind === 'space_member_add' ? 'member' : null);
      fields.push(
        effective
          ? { key: 'role', state: 'ok', value: effective, display: effective, options: roleOptions }
          : { key: 'role', state: 'needs_input', code: 'required_missing', value: null, options: roleOptions },
      );
    }

    const grant = [...new Set((intent.grant_permissions ?? []).map((k) => k.replace(/^can_/, '')))];
    const revoke = [...new Set((intent.revoke_permissions ?? []).map((k) => k.replace(/^can_/, '')))];
    if (grant.length) fields.push({ key: 'grant', state: 'ok', value: grant, display: grant.join(', '), editable: false });
    if (revoke.length) fields.push({ key: 'revoke', state: 'ok', value: revoke, display: revoke.join(', '), editable: false });
    if (kind === 'space_member_permissions' && !grant.length && !revoke.length)
      fields.push({ key: 'grant', state: 'blocked', code: 'nothing_to_change', value: null, editable: false });

    const planRole = kind === 'space_member_add' ? (role ?? 'member') : kind === 'space_member_role' ? role : null;
    const spaceId = space?.id ?? null;

    if (userId && spaceId && this.governance) {
      const problem = await this.governance.memberProblem(batch.invoker, {
        kind,
        spaceId,
        userId,
        role: planRole,
        grant,
        revoke,
      });
      if (problem)
        fields.push({
          key: 'rule',
          state: 'blocked',
          code: problem as AgentFieldCode,
          value: null,
          editable: false,
        });
      if (kind === 'space_member_remove' && !problem) {
        const stays = await this.governance.keepsAccessAfterRemoval(batch.invoker.organizationId, userId);
        fields.push({
          key: 'notice',
          state: 'check',
          code: stays ? 'keeps_access_org_admin' : 'removal_is_final',
          value: null,
          advisory: true,
          editable: false,
        });
      }
      if (kind === 'space_member_permissions' && revoke.length) {
        const kept = await this.governance.keepsThroughRole(batch.invoker.organizationId, spaceId, userId, revoke);
        if (kept.length)
          fields.push({
            key: 'notice',
            state: 'check',
            code: 'keeps_through_role',
            params: { refs: kept.join(', ') },
            value: null,
            advisory: true,
            editable: false,
          });
      }
    }

    const name = row?.display ?? intent.member?.said ?? '';
    return {
      title: cut(stripMarkup(name), MAX_TITLE),
      description: null,
      confirmable: !!userId && fields.every((f) => f.state !== 'needs_input' && f.state !== 'blocked'),
      fields,
      create: {
        kind,
        spaceId,
        ...(pendingSpace !== null && { pendingSpace }),
        userId: userId ?? '',
        role: planRole,
        grant,
        revoke,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Space
  // ---------------------------------------------------------------------------

  /** Every space of the organization, archived ones too (so a stale id is recognised). */
  private orgSpaces(batch: AgentResolveBatch): Promise<SpaceRow[]> {
    return this.memo(batch, 'spaces', async () => {
      const { data, error } = await this.client
        .from('spaces')
        .select('id, key, name, is_archived')
        .eq('organization_id', batch.invoker.organizationId)
        .is('deleting_at', null)
        .order('name', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as SpaceRow[];
    });
  }

  private isAdmin(batch: AgentResolveBatch, userId: string): Promise<boolean> {
    return this.memo(batch, `admin:${userId}`, () =>
      this.permissions.isAdminOrOwner(userId, batch.invoker.organizationId),
    );
  }

  /** Membership of one person in one space, groups and roles included (cached 10 s). */
  private async isSpaceMember(
    batch: AgentResolveBatch,
    userId: string,
    spaceId: string,
  ): Promise<boolean> {
    if (await this.isAdmin(batch, userId)) return true;
    const resolved = await this.permissions.getUserSpacePermissions(
      userId,
      batch.invoker.organizationId,
      spaceId,
    );
    return resolved.isMember;
  }

  /**
   * Same rule as TasksMineWriteService.hasSpacePermission(create_tasks) and
   * WikiMineWriteService.hasSpacePermission(create_wiki_pages).
   */
  private async canCreateIn(
    batch: AgentResolveBatch,
    spaceId: string,
    perm: CreateScope['perm'] = 'create_tasks',
  ): Promise<boolean> {
    // createPlan has no owner or admin bypass (1.22): a space member with create_plans only.
    if (perm === 'create_plans')
      return this.memo(batch, `create-plans:${spaceId}`, async () => !!(await this.productPlans?.canCreateIn(batch.invoker, spaceId)));
    if (await this.isAdmin(batch, batch.invoker.userId)) return true;
    // The same question the route's guard asks (it also counts an org grant for members).
    if (perm === 'manage_members')
      return this.permissions.hasSpacePermission(
        batch.invoker.userId,
        batch.invoker.organizationId,
        spaceId,
        perm,
      );
    const resolved = await this.permissions.getUserSpacePermissions(
      batch.invoker.userId,
      batch.invoker.organizationId,
      spaceId,
    );
    return resolved.isMember && resolved.permissions[perm] === true;
  }

  private moduleOn(
    batch: AgentResolveBatch,
    module: CreateScope['module'] = 'tasks',
  ): Promise<boolean> {
    if (!module) return Promise.resolve(true);
    return this.memo(batch, `${module}-module`, () =>
      this.modules.isEnabled(batch.invoker.organizationId, module),
    );
  }

  /** Spaces where the module is on (space toggle). */
  private moduleSpaces(
    batch: AgentResolveBatch,
    module: Exclude<CreateScope['module'], null> = 'tasks',
  ): Promise<Set<string>> {
    return this.memo(
      batch,
      `${module}-spaces`,
      async () =>
        new Set(
          await this.modules.getEnabledSpaceIds(
            batch.invoker.organizationId,
            module,
          ),
        ),
    );
  }

  /**
   * Spaces the invoker may create tasks in, with the module on, sorted by name, at most 50.
   * Candidates are the spaces with any active membership row (direct, group or role), then
   * each is checked with the full permission resolve, so group and role members are found too.
   * ponytail: an owner or admin gets the first 50 spaces by name; the picker searches the
   * server once tenants pass that.
   */
  private allowedSpaces(
    batch: AgentResolveBatch,
    scope: CreateScope = TASK_SCOPE,
  ): Promise<SpaceRow[]> {
    return this.memo(batch, `allowed-spaces:${scope.module}`, async () => {
      if (!(await this.moduleOn(batch, scope.module))) return [];
      const [spaces, enabled, admin] = await Promise.all([
        this.orgSpaces(batch),
        scope.module ? this.moduleSpaces(batch, scope.module) : null,
        this.isAdmin(batch, batch.invoker.userId),
      ]);
      const open = spaces.filter((s) => !s.is_archived && (!enabled || enabled.has(s.id)));
      if (admin && scope.perm !== 'create_plans') return open.slice(0, MAX_SPACE_OPTIONS);

      const { data, error } = await this.client
        .from('space_members')
        .select('space_id, spaces!inner(organization_id)')
        .eq('spaces.organization_id', batch.invoker.organizationId)
        .eq('is_active', true)
        .or(
          `user_id.eq.${batch.invoker.userId},member_type.eq.group,member_type.eq.role`,
        );
      if (error) throw new Error(error.message);
      const candidates = new Set(
        ((data ?? []) as { space_id: string }[]).map((r) => r.space_id),
      );

      const out: SpaceRow[] = [];
      for (const space of open) {
        if (out.length >= MAX_SPACE_OPTIONS) break;
        if (
          candidates.has(space.id) &&
          (await this.canCreateIn(batch, space.id, scope.perm))
        )
          out.push(space);
      }
      return out;
    });
  }

  private async resolveSpace(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
    fallback: string | null = null,
  ): Promise<SpaceRow | null> {
    const scope = scopeOf(action.kind);
    // In a space of this very request: it does not exist yet, so nothing can be checked against it
    // now. Its creator becomes its owner, and every write checks again when it runs.
    const pending = action.dependsOn !== null ? batch.siblings.get(action.dependsOn) : undefined;
    if (pending?.pendingSpace != null) {
      const home = batch.siblings.get(pending.pendingSpace);
      fields.push({
        key: 'space',
        state: 'ok',
        value: null,
        display: home?.title ?? '',
        params: { ordinal: pending.pendingSpace },
        editable: false,
      });
      return null;
    }
    const [spaces, allowed] = await Promise.all([
      this.orgSpaces(batch),
      this.allowedSpaces(batch, scope),
    ]);
    const options = allowed.map((s) => ({
      value: s.id,
      label: s.name,
      hint: s.key,
    }));
    const said = action.intent.space ?? undefined;
    /** A space row that is not ok. With nowhere to create tasks, there is nothing to pick. */
    const pick = (
      state: AgentFieldState,
      code: AgentFieldCode,
      extra: Partial<AgentFieldView> = {},
    ) => {
      const nowhere = options.length === 0 && code === 'unknown_space';
      fields.push({
        key: 'space',
        state: nowhere ? 'blocked' : state,
        code: nowhere ? 'no_space_available' : code,
        value: null,
        ...(said && { said }),
        options,
        ...extra,
      });
      return null;
    };

    let chosen: SpaceRow | undefined;
    if (this.has(action, 'space')) {
      const id = action.overrides.space;
      chosen = spaces.find((s) => s.id === id && !s.is_archived);
      if (!chosen) return pick('blocked', 'unknown_space');
    } else if (said) {
      // "the AMBER wiki", "im AMBER Space": the space is AMBER.
      const key =
        nameKey(said)
          .replace(/\b(the|im|in|der|die|das|wiki|space|bereich|projekt|project)\b/g, ' ')
          .replace(/\s+/g, ' ')
          .trim() || nameKey(said);
      // The words as said first ("Projekt Alpha" is a name), then without the filler words.
      const match = (list: SpaceRow[]) =>
        [nameKey(said), key]
          .map(
            (k) =>
              list.find((s) => s.key.toLowerCase() === k) ??
              list.find((s) => nameKey(s.name) === k),
          )
          .find(Boolean);
      chosen = match(allowed);
      if (!chosen) {
        const other = match(spaces.filter((s) => !s.is_archived));
        // Named a space the invoker belongs to but may not create tasks in: say so. A space
        // they cannot see stays unknown, so its existence never leaks.
        if (
          other &&
          (await this.isSpaceMember(batch, batch.invoker.userId, other.id))
        ) {
          chosen = other;
        } else {
          return pick('needs_input', 'unknown_space');
        }
      }
    } else if (action.dependsOn !== null) {
      const parentSpace = batch.siblings.get(action.dependsOn)?.spaceId;
      chosen = spaces.find((s) => s.id === parentSpace && !s.is_archived);
    }
    // A page written from tasks or pages of one space goes there unless named otherwise.
    if (!chosen && fallback) {
      chosen = allowed.find((s) => s.id === fallback);
    }
    if (!chosen && batch.conversation.kind === 'space') {
      chosen = spaces.find(
        (s) => s.id === batch.conversation.space_id && !s.is_archived,
      );
    }
    if (!chosen) return pick('needs_input', 'unknown_space');

    const display = { value: chosen.id, display: chosen.name };
    if (
      scope.module &&
      (!(await this.moduleOn(batch, scope.module)) ||
        !(await this.moduleSpaces(batch, scope.module)).has(chosen.id))
    )
      return pick('blocked', action.kind === 'process' ? 'module_off_process' : 'module_off', display);
    if (!(await this.canCreateIn(batch, chosen.id, scope.perm)))
      return pick(
        'blocked',
        isMemberKind(action.kind)
          ? 'no_manage_permission'
          : action.kind === 'process'
            ? 'no_create_process'
            : action.kind === 'plan'
              ? 'no_create_plan'
              : 'no_create_permission',
        display,
      );

    fields.push({
      key: 'space',
      state: 'ok',
      ...display,
      ...(said && { said }),
      options,
    });
    return chosen;
  }

  // ---------------------------------------------------------------------------
  // Parent
  // ---------------------------------------------------------------------------

  private async resolveParent(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string | null,
    fields: AgentFieldView[],
  ): Promise<{ taskId: string | null; typeId: string | null }> {
    const { parent } = action.intent;
    const none = { taskId: null, typeId: null };
    const holder = action.dependsOn !== null ? batch.siblings.get(action.dependsOn) : undefined;

    // A task of a process or a new space of this request: it holds the task, it is no parent task.
    if (isContainerKind(holder?.kind)) {
      if (holder?.kind === 'process') {
        const otherSpace = !!holder.spaceId && !!spaceId && holder.spaceId !== spaceId;
        fields.push({
          key: 'process',
          state: otherSpace ? 'blocked' : 'ok',
          ...(otherSpace && { code: 'parent_other_space' as const }),
          value: null,
          params: { ordinal: action.dependsOn as number },
          editable: false,
        });
      }
      return none;
    }

    if (action.dependsOn !== null) {
      const sibling = batch.siblings.get(action.dependsOn);
      const otherSpace =
        !!sibling?.spaceId && !!spaceId && sibling.spaceId !== spaceId;
      fields.push({
        key: 'parent',
        state: otherSpace ? 'blocked' : 'ok',
        ...(otherSpace && { code: 'parent_other_space' as const }),
        value: null,
        params: { ordinal: action.dependsOn },
        editable: false,
      });
      return { taskId: null, typeId: sibling?.taskTypeId ?? null };
    }

    const ref = this.has(action, 'parent')
      ? (this.text(action, 'parent') ?? null)
      : parent.key;
    if (!ref) {
      if (
        action.kind === 'subtask' ||
        (parent.said && !this.has(action, 'parent'))
      ) {
        fields.push({
          key: 'parent',
          state: 'needs_input',
          code: 'parent_not_found',
          value: null,
          ...(parent.said && { said: parent.said }),
        });
      }
      return none;
    }

    const task = await this.memo(
      batch,
      `task:${ref.toUpperCase()}`,
      async () => {
        const { data, error } = await this.client
          .from('tasks')
          .select('id, key, summary, space_id, task_type_id')
          .eq('organization_id', batch.invoker.organizationId)
          .eq(
            UUID.test(ref) ? 'id' : 'key',
            UUID.test(ref) ? ref : ref.toUpperCase(),
          )
          .maybeSingle();
        if (error) throw new Error(error.message);
        return data as {
          id: string;
          key: string | null;
          summary: string;
          space_id: string | null;
          task_type_id: string | null;
        } | null;
      },
    );
    // Only a task in a space the invoker belongs to is named; anything else is "not found".
    const visible =
      !!task?.space_id &&
      (await this.isSpaceMember(batch, batch.invoker.userId, task.space_id));
    if (!task || !visible) {
      fields.push({
        key: 'parent',
        state: 'needs_input',
        code: 'parent_not_found',
        value: null,
        said: parent.key ?? ref,
      });
      return none;
    }
    const otherSpace = !!spaceId && task.space_id !== spaceId;
    fields.push({
      key: 'parent',
      state: otherSpace ? 'blocked' : 'ok',
      ...(otherSpace && { code: 'parent_other_space' as const }),
      value: task.id,
      display: task.key ? `${task.key} ${task.summary}` : task.summary,
    });
    return otherSpace
      ? none
      : { taskId: task.id, typeId: task.task_type_id ?? null };
  }

  // ---------------------------------------------------------------------------
  // Type, status, priority
  // ---------------------------------------------------------------------------

  private async resolveType(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string,
    parentTypeId: string | null,
    fields: AgentFieldView[],
  ): Promise<ITaskTypeLevel | null> {
    const org = batch.invoker.organizationId;
    const active = await this.memo(batch, `types:${spaceId}`, () =>
      this.hierarchy.getActiveTypes(org, spaceId),
    );
    const candidates = parentTypeId
      ? await this.memo(
          batch,
          `children:${spaceId}:${parentTypeId}`,
          async () => {
            const ids = new Set(
              (
                await this.hierarchy.getValidChildTypesFor(
                  org,
                  spaceId,
                  parentTypeId,
                )
              ).map((t) => t.id),
            );
            return active.filter((t) => ids.has(t.id));
          },
        )
      : active;
    const options = candidates.map((t) => ({ value: t.id, label: t.name }));
    const said = action.intent.type ?? undefined;

    let chosen: ITaskTypeLevel | undefined;
    if (this.has(action, 'type')) {
      chosen = candidates.find((t) => t.id === action.overrides.type);
    } else if (said) {
      const key = nameKey(said);
      chosen = candidates.find(
        (t) => t.id.toLowerCase() === key || nameKey(t.name) === key,
      );
    } else if (parentTypeId || action.kind === 'subtask') {
      chosen = candidates[0];
    } else {
      // The same default as TasksMineWriteService.resolveDefaultTaskTypeId.
      chosen =
        candidates.find((t) => t.id === 'task') ??
        candidates.find((t) => !t.parent_level_id) ??
        candidates[0];
    }

    if (!chosen) {
      fields.push({
        key: 'type',
        state: candidates.length ? 'needs_input' : 'blocked',
        code: 'unknown_type',
        value: null,
        ...(said && { said }),
        options,
      });
      return null;
    }
    fields.push({
      key: 'type',
      state: 'ok',
      value: chosen.id,
      display: chosen.name,
      ...(said && { said }),
      options,
    });
    return chosen;
  }

  private async resolveStatus(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string,
    type: ITaskTypeLevel | null,
    fields: AgentFieldView[],
  ): Promise<string | null> {
    const org = batch.invoker.organizationId;
    const statuses = await this.memo(batch, `statuses:${spaceId}`, async () =>
      (await this.statuses.getAll(org, spaceId, { is_active: 'true' })).map(
        (s) => s as unknown as StatusRow,
      ),
    );
    const said = action.intent.status ?? undefined;

    // A workflow on the type decides the first status; the card shows it, fixed.
    const initial = type
      ? await this.memo(batch, `workflow:${spaceId}:${type.id}`, async () => {
          const assignment = await this.assignments.findActiveAssignmentForType(
            org,
            spaceId,
            type.id,
          );
          if (!assignment) return null;
          const { data, error } = await this.client
            .from('workflows')
            .select('initial_status_id')
            .eq('id', assignment.workflow_id)
            .eq('organization_id', org)
            .maybeSingle();
          if (error) throw new Error(error.message);
          return (
            (data as { initial_status_id: string | null } | null)
              ?.initial_status_id ?? null
          );
        })
      : null;
    if (initial) {
      fields.push({
        key: 'status',
        state: 'ok',
        code: 'status_fixed_by_workflow',
        value: initial,
        ...(statuses.find((s) => s.id === initial) && {
          display: statuses.find((s) => s.id === initial)?.name,
        }),
        ...(said && { said }),
        editable: false,
      });
      return null;
    }

    const options = statuses.map((s) => ({ value: s.id, label: s.name }));
    const fallback = statuses.find((s) => s.key === type?.default_status);
    let chosen: StatusRow | undefined;
    if (this.has(action, 'status')) {
      chosen = statuses.find((s) => s.id === action.overrides.status);
    } else if (said) {
      const key = nameKey(said);
      chosen = statuses.find(
        (s) => s.key.toLowerCase() === key || nameKey(s.name) === key,
      );
    } else {
      chosen = fallback;
    }

    if (!chosen && (said || this.has(action, 'status'))) {
      fields.push({
        key: 'status',
        state: 'check',
        code: 'unknown_status',
        value: fallback?.id ?? null,
        ...(fallback && { display: fallback.name }),
        ...(said && { said }),
        options,
      });
      return fallback?.id ?? null;
    }
    fields.push({
      key: 'status',
      state: 'ok',
      value: chosen?.id ?? null,
      ...(chosen && { display: chosen.name }),
      ...(said && { said }),
      options,
    });
    return chosen?.id ?? null;
  }

  private async resolvePriority(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string,
    type: ITaskTypeLevel | null,
    fields: AgentFieldView[],
  ): Promise<string | null> {
    const org = batch.invoker.organizationId;
    const rows = await this.memo(batch, `priorities:${spaceId}`, async () => {
      const all = (
        await this.priorities.getAll(org, spaceId, { is_active: 'true' })
      ).map((p) => p as unknown as PriorityRow);
      // One per key; the space's own row wins over the organization's.
      const byKey = new Map<string, PriorityRow>();
      for (const p of all) {
        if (!byKey.has(p.key) || p.space_id) byKey.set(p.key, p);
      }
      return [...byKey.values()];
    });
    const { said, level } = action.intent.priority;
    const options = rows.map((p) => ({ value: p.id, label: p.name }));
    const fallback = rows.find((p) => p.key === type?.default_priority);
    const find = (word: string) => {
      const key = nameKey(word);
      return rows.find(
        (p) => p.key.toLowerCase() === key || nameKey(p.name) === key,
      );
    };

    let chosen: PriorityRow | undefined;
    let asked = false;
    if (this.has(action, 'priority')) {
      asked = action.overrides.priority !== null;
      chosen = rows.find((p) => p.id === action.overrides.priority);
    } else if (said || level !== 'none') {
      asked = true;
      chosen =
        (said ? find(said) : undefined) ??
        (level !== 'none' ? find(level) : undefined);
    }

    if (asked && !chosen) {
      fields.push({
        key: 'priority',
        state: 'check',
        code: 'unknown_priority',
        value: fallback?.id ?? null,
        ...(fallback && { display: fallback.name }),
        ...(said && { said }),
        options,
      });
      return fallback?.key ?? null;
    }
    const value = chosen ?? fallback;
    fields.push({
      key: 'priority',
      state: 'ok',
      value: value?.id ?? null,
      ...(value && { display: value.name }),
      ...(said && { said }),
      options,
    });
    return chosen?.key ?? null;
  }

  // ---------------------------------------------------------------------------
  // Assignee
  // ---------------------------------------------------------------------------

  /** One active member of the organization with their name; null for anyone else. */
  private async people(
    batch: AgentResolveBatch,
    id: string,
  ): Promise<PersonRow | null> {
    return this.memo(batch, `person:${id}`, async () => {
      if (!UUID.test(id)) return null;
      const [member, users] = await Promise.all([
        this.client
          .from('organization_members')
          .select('user_id')
          .eq('organization_id', batch.invoker.organizationId)
          .eq('user_id', id)
          .maybeSingle(),
        this.client
          .from('users')
          .select('id, is_active')
          .eq('id', id)
          .maybeSingle(),
      ]);
      if (member.error || users.error)
        throw new Error('Could not load the person');
      const active =
        (users.data as { is_active: boolean | null } | null)?.is_active !==
        false;
      if (!member.data || !users.data || !active) return null;
      const summary = (await this.conversations.loadUsers([id])).get(id);
      return { id, name: summary?.name ?? '', email: summary?.email ?? null };
    });
  }

  private async inConversation(
    batch: AgentResolveBatch,
    userId: string,
  ): Promise<boolean> {
    const { conversation, invoker } = batch;
    if (conversation.kind === 'space') {
      return this.access.canViewSpace(
        userId,
        invoker.organizationId,
        conversation.space_id,
      );
    }
    const { data, error } = await this.client
      .from('chat_members')
      .select('user_id')
      .eq('conversation_id', conversation.id)
      .eq('organization_id', invoker.organizationId)
      .eq('user_id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  }

  private async resolveAssignee(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string | null,
    fields: AgentFieldView[],
  ): Promise<string | null> {
    const { assignee } = action.intent;
    const said = assignee.said ?? undefined;
    const base = { key: 'assignee', ...(said && { said }) };

    let person: PersonRow | null = null;
    if (this.has(action, 'assignee')) {
      const id = action.overrides.assignee;
      if (id === null) {
        fields.push({ ...base, state: 'ok', value: null });
        return null;
      }
      person = await this.people(batch, typeof id === 'string' ? id : '');
      if (!person) {
        fields.push({
          ...base,
          state: 'needs_input',
          code: 'unknown_person',
          value: null,
        });
        return null;
      }
    } else if (assignee.is_requester || assignee.user_id) {
      person = await this.people(
        batch,
        assignee.is_requester
          ? batch.invoker.userId
          : (assignee.user_id as string),
      );
    }

    if (!person && !this.has(action, 'assignee') && said) {
      const matches = await this.memo(batch, `find:${nameKey(said)}`, () =>
        this.runs.findMembers(batch.invoker.organizationId, said, MAX_PEOPLE),
      );
      const exact = matches.filter((m) => m.exact);
      const only =
        exact.length === 1
          ? exact[0]
          : matches.length === 1
            ? matches[0]
            : null;
      if (!only) {
        fields.push({
          ...base,
          state: 'needs_input',
          code: matches.length ? 'ambiguous_person' : 'unknown_person',
          value: null,
          ...(said && { params: { name: said } }),
          options: matches.map((m) => ({
            value: m.user_id,
            label: m.full_name || m.email || m.user_id,
            ...(m.email && { hint: m.email }),
          })),
        });
        return null;
      }
      person = { id: only.user_id, name: only.full_name, email: only.email };
    }

    if (!person) {
      // Nobody named, or a handle that no longer stands for an active member.
      const lost = assignee.is_requester || !!assignee.user_id;
      fields.push({
        ...base,
        state: lost ? 'needs_input' : 'ok',
        ...(lost && { code: 'unknown_person' as const }),
        value: null,
      });
      return null;
    }

    const shown = { value: person.id, display: person.name };
    const pendingHome = this.pendingSpaceOf(batch, action);
    if (
      pendingHome !== null &&
      !isMemberKind(action.kind) &&
      person.id !== batch.invoker.userId &&
      ![...batch.siblings.values()].some(
        (s) => s.kind === 'space_member_add' && s.userId === person.id && s.pendingSpace === pendingHome,
      ) &&
      !(await this.isAdmin(batch, person.id))
    ) {
      // A new space holds its creator and the org admins; anyone else must join in this request.
      fields.push({ ...base, ...shown, state: 'needs_input', code: 'not_space_member', params: { name: person.name } });
      return null;
    }
    if (spaceId && !(await this.isSpaceMember(batch, person.id, spaceId))) {
      fields.push({
        ...base,
        ...shown,
        state: 'needs_input',
        code: 'not_space_member',
        params: { name: person.name },
      });
      return null;
    }
    // The chat says nothing about who works in a space this request creates: not worth a warning on every card.
    if (pendingHome === null && !(await this.inConversation(batch, person.id))) {
      fields.push({
        ...base,
        ...shown,
        state: 'check',
        code: 'assignee_not_in_conversation',
        advisory: true,
      });
      return person.id;
    }
    fields.push({ ...base, ...shown, state: 'ok' });
    return person.id;
  }

  // ---------------------------------------------------------------------------
  // Due date and labels
  // ---------------------------------------------------------------------------

  private resolveDue(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    fields: AgentFieldView[],
  ): string | null {
    const { due } = action.intent;
    const said = due.said ?? undefined;
    const base = { key: 'due', ...(said && { said }) };
    const ctx = { timezone: batch.timezone, now: batch.now };

    let value: string | null;
    if (this.has(action, 'due')) {
      const raw = action.overrides.due;
      value = raw === null ? null : strictDay(raw);
      if (raw !== null && !value) {
        fields.push({
          ...base,
          state: 'needs_input',
          code: 'invalid_date',
          value: null,
        });
        return null;
      }
    } else {
      // The calendar in the invoker's timezone wins over the model's arithmetic.
      value = (said ? resolveDateWords(said, ctx) : null) ?? strictDay(due.iso);
      if (!value && (said || due.iso)) {
        fields.push({
          ...base,
          state: 'needs_input',
          code: 'invalid_date',
          value: null,
        });
        return null;
      }
    }

    const today = calendarDays(batch.timezone, batch.now, 1)[0].date;
    fields.push(
      value && value < today
        ? { ...base, state: 'check', code: 'date_in_past', value }
        : { ...base, state: 'ok', value },
    );
    return value;
  }

  private async resolveLabels(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string | null,
    fields: AgentFieldView[],
  ): Promise<string[]> {
    const raw = this.has(action, 'labels')
      ? (action.overrides.labels as unknown[])
      : action.intent.labels;
    const labels = [
      ...new Set(
        (Array.isArray(raw) ? raw : [])
          .map((l) =>
            cut(stripMarkup(String(l)).replace(/\s+/g, ' '), MAX_LABEL),
          )
          .filter(Boolean),
      ),
    ].slice(0, MAX_LABELS);

    const known = spaceId
      ? await this.memo(
          batch,
          `labels:${spaceId}`,
          async () =>
            new Set(
              (
                await this.runs.spaceLabels(
                  batch.invoker.organizationId,
                  spaceId,
                )
              ).map(nameKey),
            ),
        )
      : new Set<string>();
    const fresh = labels.filter((l) => !known.has(nameKey(l)));
    fields.push(
      fresh.length
        ? {
            key: 'labels',
            state: 'check',
            code: 'new_label',
            params: { labels: fresh.join(', '), count: fresh.length },
            value: labels,
            advisory: true,
          }
        : { key: 'labels', state: 'ok', value: labels },
    );
    return labels;
  }

  // ---------------------------------------------------------------------------
  // Required custom fields
  // ---------------------------------------------------------------------------

  /** The required, visible, active custom fields of a type in a space, with their rows. */
  requiredFields(
    batch: AgentResolveBatch,
    spaceId: string,
    typeId: string,
  ): Promise<Record<string, unknown>[]> {
    const org = batch.invoker.organizationId;
    return this.memo(batch, `fields:${spaceId}:${typeId}`, async () => {
      const config = (await this.fieldGroups.getLevelFieldsConfiguration(
        org,
        typeId,
        'task',
        false,
        spaceId,
      )) as {
        standalone_fields?: unknown[];
        groups?: Array<{ field_group?: { fields?: unknown[] } }>;
      };
      const ids = new Set<string>();
      const take = (row: unknown) => {
        const a = row as {
          is_required?: boolean;
          is_hidden?: boolean;
          is_enabled_in_space?: boolean;
          custom_field?: { id?: string; is_active?: boolean } | null;
        };
        if (
          a.is_required === true &&
          a.is_hidden !== true &&
          a.is_enabled_in_space !== false &&
          a.custom_field?.id &&
          a.custom_field.is_active !== false
        )
          ids.add(a.custom_field.id);
      };
      for (const row of config.standalone_fields ?? []) take(row);
      for (const group of config.groups ?? [])
        for (const row of group.field_group?.fields ?? []) take(row);
      if (ids.size === 0) return [];

      const { data, error } = await this.client
        .from('custom_fields')
        .select('*')
        .eq('organization_id', org)
        .in('id', [...ids])
        .order('sort_order', { ascending: true });
      if (error) throw new Error(error.message);
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        ...row,
        is_required: true,
      }));
    });
  }

  private async resolveCustomFields(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string,
    typeId: string,
    fields: AgentFieldView[],
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const def of await this.requiredFields(batch, spaceId, typeId)) {
      const key = `custom:${def.id as string}`;
      const value = action.overrides[key];
      const empty =
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0);
      let valid = !empty;
      if (valid) {
        try {
          validateFieldValue(def as unknown as CustomField, value);
        } catch {
          valid = false;
        }
      }
      fields.push({
        key,
        state: valid ? 'ok' : 'needs_input',
        ...(!valid && { code: 'required_missing' as const }),
        value: empty ? null : value,
        display: typeof def.name === 'string' ? def.name : '',
        fieldDef: def,
      });
      if (valid && typeof def.field_key === 'string')
        out[def.field_key] = value;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Wiki pages (1.15)
  // ---------------------------------------------------------------------------

  private async resolveWiki(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
  ): Promise<AgentResolved> {
    const { intent } = action;
    const handles = intent.wiki;
    const fields: AgentFieldView[] = [];

    // "FAQ Passkeys im AMBER Wiki": where the page goes is its space, not part of its title.
    const rawTitle = stripMarkup(
      this.text(action, 'title') ??
        intent.title.replace(/\s+(im|in( the)?|in der)\s+[\p{L}\p{N}-]+\s+(wiki|space)$/iu, ''),
    );
    const title = cut(rawTitle.replace(/\s+/g, ' '), MAX_TITLE);
    fields.push(
      !title
        ? { key: 'title', state: 'blocked', code: 'required_missing', value: '' }
        : Array.from(rawTitle).length > MAX_TITLE
          ? { key: 'title', state: 'check', code: 'too_long', params: { max: MAX_TITLE }, value: title }
          : { key: 'title', state: 'ok', value: title },
    );

    // All material read for the run decides who may see the card; the material the page shows
    // (its task cards and included pages) suggests the space when the request names none.
    const material = [
      ...Object.values(handles?.tasks ?? {}).map((t) => t.spaceId),
      ...Object.values(handles?.pages ?? {}).map((p) => p.spaceId),
    ].filter((id): id is string => !!id);
    const shown = (intent.body ?? [])
      .filter((b) => b.type === 'task_cards' || b.type === 'include_page' || b.type === 'heading')
      .flatMap((b) => [...(b.refs ?? []), ...(b.type === 'task_cards' ? (b.items ?? []) : [])])
      .map((r) => handles?.tasks[r.trim()]?.spaceId ?? handles?.pages[r.trim()]?.spaceId)
      .filter((id): id is string => !!id);
    const single = shown.length && new Set(shown).size === 1 ? shown[0] : null;
    const space = await this.resolveSpace(batch, action, fields, single);
    const spaceId = space?.id ?? null;
    const pendingSpace = this.pendingSpaceOf(batch, action);

    const parent = await this.resolveParentPage(batch, action, space, fields);
    const publish = await this.resolvePublish(batch, action, spaceId, fields);
    const labelIds = await this.resolveWikiLabels(batch, action, spaceId, fields);

    // The body, rendered with ids the invoker may use only.
    const body = await this.renderBody(batch, action, space, fields);

    if (title && spaceId) {
      const similar = await this.similarPage(batch, spaceId, parent.pageId, title);
      if (similar)
        fields.push({
          key: 'similar',
          state: 'check',
          code: 'similar_page',
          value: similar.id,
          display: similar.title,
          advisory: true,
          editable: false,
        });
    }

    const missing = handles?.missing ?? [];
    if (missing.length)
      fields.push({
        key: 'references',
        state: 'check',
        code: 'reference_not_found',
        params: { refs: missing.join(', '), count: missing.length },
        value: null,
        advisory: true,
        editable: false,
      });

    const confirmable = fields.every((f) => f.state !== 'needs_input' && f.state !== 'blocked');
    return {
      title,
      description: null,
      confirmable,
      fields,
      create: {
        kind: 'wiki_page',
        spaceId,
        parentPageId: parent.pageId,
        title,
        doc: body.doc as unknown as Record<string, unknown>,
        labelIds,
        publish,
        items: body.items,
        readSpaces: [...new Set(material)],
        restricted: (handles?.restricted ?? false) || parent.restricted,
        ...(pendingSpace !== null && { pendingSpace }),
      },
    };
  }

  /** The parent page: one of this run's pages, an existing page by id (an edit), or by its title. */
  private async resolveParentPage(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    space: SpaceRow | null,
    fields: AgentFieldView[],
  ): Promise<{ pageId: string | null; restricted: boolean }> {
    const none = { pageId: null, restricted: false };
    const spaceId = space?.id ?? null;
    // The page documents a process of this request, or opens a new space: no parent page.
    const holder = action.dependsOn !== null ? batch.siblings.get(action.dependsOn) : undefined;
    if (isContainerKind(holder?.kind)) {
      if (holder?.kind === 'process')
        fields.push({
          key: 'process',
          state: 'ok',
          value: null,
          params: { ordinal: action.dependsOn as number },
          editable: false,
        });
      fields.push({ key: 'parentPage', state: 'ok', value: null, editable: false });
      return none;
    }
    if (action.dependsOn !== null && !this.has(action, 'parentPage')) {
      const sibling = batch.siblings.get(action.dependsOn);
      const otherSpace = !!sibling?.spaceId && !!spaceId && sibling.spaceId !== spaceId;
      fields.push({
        key: 'parentPage',
        state: otherSpace ? 'blocked' : 'ok',
        ...(otherSpace && { code: 'parent_other_space' as const }),
        value: null,
        params: { ordinal: action.dependsOn },
        editable: false,
      });
      return none;
    }

    const override = this.has(action, 'parentPage');
    const named = action.intent.parent_page?.trim() || null;
    // "in the AMBER wiki" names the space, not a page under it.
    const said =
      named && space && [space.key, space.name].some((n) => nameKey(n) === nameKey(named))
        ? null
        : named;
    const chosenId = override ? (this.text(action, 'parentPage') ?? null) : null;
    // No parent wanted: a top-level page.
    if (override ? !chosenId : !said) {
      fields.push({ key: 'parentPage', state: 'ok', value: null });
      return none;
    }
    if (!spaceId) {
      fields.push({ key: 'parentPage', state: 'ok', value: null, ...(said && { said }), editable: false });
      return none;
    }

    const candidates = chosenId
      ? await this.pagesById(batch, spaceId, [chosenId])
      : await this.pagesByTitle(batch, spaceId, said ?? '');
    const usable: { id: string; title: string; level: number }[] = [];
    for (const page of candidates) {
      if (page.level <= MAX_PARENT_LEVEL && (await this.canCreateUnder(batch, spaceId, page.id)))
        usable.push(page);
    }

    if (usable.length === 1) {
      const page = usable[0];
      fields.push({
        key: 'parentPage',
        state: 'ok',
        value: page.id,
        display: page.title,
        ...(said && { said }),
      });
      return { pageId: page.id, restricted: await this.pageRestricted(batch, page.id) };
    }
    const options = (usable.length ? usable : await this.recentPages(batch, spaceId)).map((p) => ({
      value: p.id,
      label: p.title,
    }));
    fields.push({
      key: 'parentPage',
      state: 'needs_input',
      code: usable.length > 1 ? 'ambiguous_parent' : 'parent_not_found',
      value: null,
      ...(said && { said }),
      options,
    });
    return none;
  }

  private async pagesByTitle(
    batch: AgentResolveBatch,
    spaceId: string,
    title: string,
  ): Promise<{ id: string; title: string; level: number }[]> {
    const key = nameKey(title);
    if (!key) return [];
    const { data, error } = await this.client
      .from('wiki_pages')
      .select('id, title, level')
      .eq('organization_id', batch.invoker.organizationId)
      .eq('space_id', spaceId)
      .eq('is_archived', false)
      .ilike('title', `%${title.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
      .limit(50);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string; title: string; level: number }[]).filter(
      (p) => nameKey(p.title) === key,
    );
  }

  private async pagesById(
    batch: AgentResolveBatch,
    spaceId: string,
    ids: string[],
  ): Promise<{ id: string; title: string; level: number }[]> {
    const valid = ids.filter((id) => UUID.test(id));
    if (!valid.length) return [];
    const { data, error } = await this.client
      .from('wiki_pages')
      .select('id, title, level')
      .eq('organization_id', batch.invoker.organizationId)
      .eq('space_id', spaceId)
      .eq('is_archived', false)
      .in('id', valid);
    if (error) throw new Error(error.message);
    return (data ?? []) as { id: string; title: string; level: number }[];
  }

  /** Pages of the space to pick a parent from: the ten most recently changed the invoker may create under. */
  async recentPages(
    batch: AgentResolveBatch,
    spaceId: string,
    query?: string,
  ): Promise<{ id: string; title: string; level: number }[]> {
    let q = this.client
      .from('wiki_pages')
      .select('id, title, level')
      .eq('organization_id', batch.invoker.organizationId)
      .eq('space_id', spaceId)
      .eq('is_archived', false)
      .lte('level', MAX_PARENT_LEVEL);
    if (query?.trim()) q = q.ilike('title', `%${query.trim().replace(/[%_\\]/g, (c) => `\\${c}`)}%`);
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(30);
    if (error) throw new Error(error.message);
    const out: { id: string; title: string; level: number }[] = [];
    for (const page of (data ?? []) as { id: string; title: string; level: number }[]) {
      if (out.length >= 10) break;
      if (await this.canCreateUnder(batch, spaceId, page.id)) out.push(page);
    }
    return out;
  }

  /** The wiki's own create-under rule (can_create on the parent, from its access list). */
  private canCreateUnder(batch: AgentResolveBatch, spaceId: string, pageId: string): Promise<boolean> {
    return this.memo(batch, `can-create-under:${pageId}`, async () => {
      if (!this.wikiPermissions) return false;
      try {
        await this.wikiPermissions.assertPageAccess(pageId, batch.invoker.userId, spaceId, 'can_create');
        return true;
      } catch {
        return false;
      }
    });
  }

  private pageRestricted(batch: AgentResolveBatch, pageId: string): Promise<boolean> {
    return this.memo(batch, `restricted:${pageId}`, async () => {
      const { data } = await this.client
        .from('wiki_pages')
        .select('path, has_custom_permissions')
        .eq('id', pageId)
        .eq('organization_id', batch.invoker.organizationId)
        .maybeSingle();
      const row = data as { path: string[] | null; has_custom_permissions: boolean } | null;
      if (!row) return true;
      if (row.has_custom_permissions) return true;
      if (!row.path?.length) return false;
      const { data: up } = await this.client
        .from('wiki_pages')
        .select('id')
        .eq('organization_id', batch.invoker.organizationId)
        .in('id', row.path)
        .eq('has_custom_permissions', true)
        .limit(1);
      return (up ?? []).length > 0;
    });
  }

  /** Published only when asked and the space lets the invoker skip its review. */
  private async resolvePublish(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string | null,
    fields: AgentFieldView[],
  ): Promise<boolean> {
    const asked = this.has(action, 'publish')
      ? action.overrides.publish === true
      : action.intent.publish === true;
    if (!asked) {
      fields.push({ key: 'publish', state: 'ok', value: false });
      return false;
    }
    const allowed =
      !!spaceId &&
      !!this.wikiWrite &&
      (await this.memo(batch, `may-publish:${spaceId}`, () =>
        this.wikiWrite!.mayPublishDirectly(batch.invoker as RequestUser, spaceId),
      ));
    if (spaceId && !allowed) {
      fields.push({ key: 'publish', state: 'check', code: 'review_required', value: false, advisory: true });
      return false;
    }
    fields.push({ key: 'publish', state: 'ok', value: true });
    return true;
  }

  /** Existing wiki labels of the space by name; others are not created by Robert. */
  private async resolveWikiLabels(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    spaceId: string | null,
    fields: AgentFieldView[],
  ): Promise<string[]> {
    const raw = this.has(action, 'labels') ? (action.overrides.labels as unknown[]) : action.intent.labels;
    const labels = [
      ...new Set(
        (Array.isArray(raw) ? raw : [])
          .map((l) => cut(stripMarkup(String(l)).replace(/\s+/g, ' '), MAX_WIKI_LABEL))
          .filter(Boolean),
      ),
    ].slice(0, MAX_LABELS);
    const known = spaceId ? await this.wikiLabels(batch, spaceId) : new Map<string, string>();
    const ids = labels.map((l) => known.get(nameKey(l))).filter((id): id is string => !!id);
    const unknown = spaceId ? labels.filter((l) => !known.has(nameKey(l))) : [];
    fields.push(
      unknown.length
        ? {
            key: 'labels',
            state: 'check',
            code: 'unknown_label',
            params: { labels: unknown.join(', '), count: unknown.length },
            value: labels,
            advisory: true,
          }
        : { key: 'labels', state: 'ok', value: labels },
    );
    return ids;
  }

  /** The wiki labels of a space, by name key → id. */
  private wikiLabels(batch: AgentResolveBatch, spaceId: string): Promise<Map<string, string>> {
    return this.memo(batch, `wiki-labels:${spaceId}`, async () => {
      const { data, error } = await this.client
        .from('wiki_labels')
        .select('id, name')
        .eq('space_id', spaceId)
        .limit(500);
      if (error) throw new Error(error.message);
      return new Map(((data ?? []) as { id: string; name: string }[]).map((l) => [nameKey(l.name), l.id]));
    });
  }

  /** The active task statuses of a space (its own and the organization's), by name and key → id. */
  private spaceStatuses(batch: AgentResolveBatch, spaceId: string): Promise<Map<string, string>> {
    return this.memo(batch, `statuses:${spaceId}`, async () => {
      const { data, error } = await this.client
        .from('task_statuses')
        .select('id, name, key')
        .eq('organization_id', batch.invoker.organizationId)
        .eq('is_active', true)
        .or(`space_id.is.null,space_id.eq.${spaceId}`)
        .limit(200);
      if (error) throw new Error(error.message);
      const out = new Map<string, string>();
      for (const s of (data ?? []) as { id: string; name: string; key: string | null }[]) {
        if (s.key) out.set(nameKey(s.key.replace(/_/g, ' ')), s.id);
        out.set(nameKey(s.name), s.id);
      }
      return out;
    });
  }

  /** Renders the body with what the invoker may reference, and the body row of the card. */
  private async renderBody(
    batch: AgentResolveBatch,
    action: AgentResolveAction,
    space: SpaceRow | null,
    fields: AgentFieldView[],
  ) {
    const handles = action.intent.wiki;
    // Labels on a live table are filter values like its items (statuses or task labels).
    let blocks = ((action.intent.body ?? []) as WikiBlock[]).map((b) =>
      b.type === 'task_table' && b.labels.length ? { ...b, items: [...b.items, ...b.labels], labels: [] } : b,
    );
    // A task table "status" that is no status of the space but a label its tasks carry: the
    // model meant the tasks with that label (task_cards keeps them live, one card each).
    if (space && blocks.some((b) => b.type === 'task_table' && b.items.length)) {
      const statuses = await this.spaceStatuses(batch, space.id);
      const isStatus = (s: string) => statuses.has(nameKey(s.replace(/_/g, ' ')));
      blocks = await Promise.all(
        blocks.map(async (b) =>
          b.type === 'task_table' && b.items.length && !b.items.some(isStatus) &&
          (await this.tasksWithLabels(batch, space.id, b.items)).length
            ? { ...b, type: 'task_cards' as const, labels: b.items, items: [], refs: [] }
            : b,
        ),
      );
    }

    // Keys written as such ("AMBER-T25") that are not among the material: looked up as the invoker.
    const keys = new Map<string, WikiTaskRef | null>();
    for (const b of blocks) {
      if (b.type !== 'task_cards') continue;
      for (const r of [...b.refs, ...b.items]) {
        const ref = r.trim();
        if (handles?.tasks[ref] || handles?.items[ref] !== undefined) continue;
        if (/^[A-Z][A-Z0-9]*-T\d+$/i.test(ref)) keys.set(ref, await this.viewableTask(batch, ref));
      }
    }
    // Tasks by label, in the page's space.
    const labelled = new Map<number, WikiTaskRef[]>();
    for (const [i, b] of blocks.entries()) {
      if (b.type === 'task_cards' && b.labels.length && space)
        labelled.set(i, await this.tasksWithLabels(batch, space.id, b.labels));
    }

    const usesType = (...types: string[]) => blocks.some((b) => types.includes(b.type));
    const labels = space && usesType('decision_report', 'properties_report') ? await this.wikiLabels(batch, space.id) : null;
    // A live table only in a space whose tasks the invoker may view: it would show nothing otherwise.
    // A space of this request: its creator sees its tasks, and the executor fills in the id at Confirm.
    const tableSpace = !usesType('task_table')
      ? null
      : space
        ? (await this.canViewTasks(batch, space.id)) ? space.id : null
        : this.pendingSpaceOf(batch, action) !== null
          ? SPACE_PLACEHOLDER
          : null;
    const statuses = tableSpace ? await this.spaceStatuses(batch, tableSpace) : null;

    const refsOf: WikiRenderRefs = {
      language: languageOf(action),
      spaceId: tableSpace,
      status: (name) => statuses?.get(nameKey(name.replace(/_/g, ' '))) ?? null,
      label: (name) => !!labels?.has(nameKey(name)),
      numbers: new Set(handles?.numbers ?? []),
      // The reserved id is only known at Confirm; the executor sets the tree's root then.
      pageId: '00000000-0000-4000-8000-000000000000',
      spaceKey: space?.key ?? null,
      person: (h) => handles?.people[h] ?? null,
      message: (h) => {
        const id = h.startsWith('F') ? handles?.files?.[h]?.messageId : handles?.messages[h];
        return id ? `/chat/${batch.conversation.id}?m=${id}` : null;
      },
      task: (r) => {
        if (handles?.tasks[r]) return handles.tasks[r];
        if (handles?.items[r] !== undefined) return { item: handles.items[r] };
        const byKey = Object.values(handles?.tasks ?? {}).find((t) => t.key.toUpperCase() === r.toUpperCase());
        return byKey ?? keys.get(r) ?? null;
      },
      page: (r: string) => (handles?.pages[r] ? { id: handles.pages[r].id } : null),
      labelled: (i: number) => labelled.get(i) ?? null,
      sources: action.intent.sources ?? [],
      messageLabel: (h: string) => {
        if (h.startsWith('F')) return handles?.files?.[h]?.name ?? null;
        // A cited message that carries a file the page was written from is named by that file.
        const id = handles?.messages[h];
        const file = Object.values(handles?.files ?? {}).find((f) => id && f.messageId === id);
        const label = handles?.messageLabels?.[h] ?? null;
        return file ? `${file.name}${label ? ` (${label})` : ''}` : label;
      },
      generalKnowledge: action.intent.general_knowledge === true,
      runItems: Object.values(handles?.items ?? {}),
    };
    let result = renderWikiDoc(blocks, refsOf);
    // The model sometimes leaves the body for "later". A page from named tasks still shows them.
    const asked = Object.entries(handles?.tasks ?? {})
      .filter(([, t]) => (handles?.asked ?? []).includes(t.key))
      .map(([handle]) => handle);
    if (result.empty && asked.length)
      result = renderWikiDoc(
        [
          { type: 'task_cards', level: null, text: null, title: null, items: [], rows: [], variant: null, language: null, refs: asked, labels: [] },
        ],
        refsOf,
      );

    const sections = (result.doc.content as { type: string }[]).filter((n) => n.type === 'heading').length;
    // Macros built otherwise than asked: said on the card, the page itself stays valid.
    if (result.notes.length)
      fields.push({
        key: 'macros',
        state: 'check',
        code: result.notes.includes('chart_unverified') ? 'chart_unverified' : 'macro_left_out',
        value: null,
        params: { codes: result.notes.join(', '), count: result.notes.length },
        advisory: true,
        editable: false,
      });
    fields.push(
      result.empty
        ? { key: 'body', state: 'blocked', code: 'empty_body', value: null, editable: false }
        : result.trimmed
          ? { key: 'body', state: 'check', code: 'too_long', value: null, params: { sections }, editable: false }
          : result.unknown.length
            ? {
                key: 'body',
                state: 'check',
                code: 'unknown_reference',
                value: null,
                params: { refs: result.unknown.join(', '), count: result.unknown.length, sections },
                advisory: true,
                editable: false,
              }
            : { key: 'body', state: 'ok', value: null, params: { sections }, editable: false },
    );
    return result;
  }

  /** A task by key, only when the invoker may view it (same rule as getMyTask). */
  private viewableTask(batch: AgentResolveBatch, key: string): Promise<WikiTaskRef | null> {
    return this.memo(batch, `view-task:${key.toUpperCase()}`, async () => {
      const { data } = await this.client
        .from('tasks')
        .select('key, space_id')
        .eq('organization_id', batch.invoker.organizationId)
        .eq('key', key.toUpperCase())
        .maybeSingle();
      const task = data as { key: string; space_id: string | null } | null;
      if (!task?.space_id) return null;
      return (await this.canViewTasks(batch, task.space_id)) ? { key: task.key, spaceId: task.space_id } : null;
    });
  }

  private canViewTasks(batch: AgentResolveBatch, spaceId: string): Promise<boolean> {
    return this.memo(batch, `view-tasks:${spaceId}`, async () => {
      if (await this.isAdmin(batch, batch.invoker.userId)) return true;
      const resolved = await this.permissions.getUserSpacePermissions(
        batch.invoker.userId,
        batch.invoker.organizationId,
        spaceId,
      );
      return resolved.isMember && resolved.permissions.view_tasks === true;
    });
  }

  /** Open tasks of a space carrying every one of these labels, newest first (21 so "more" shows). */
  private async tasksWithLabels(
    batch: AgentResolveBatch,
    spaceId: string,
    labels: string[],
  ): Promise<WikiTaskRef[]> {
    if (!(await this.canViewTasks(batch, spaceId))) return [];
    const clean = labels.map((l) => cut(stripMarkup(l), MAX_LABEL)).filter(Boolean).slice(0, 5);
    if (!clean.length) return [];
    const { data, error } = await this.client
      .from('tasks')
      .select('key')
      .eq('organization_id', batch.invoker.organizationId)
      .eq('space_id', spaceId)
      // tasks.labels is jsonb: an array would be sent as a Postgres array literal and rejected.
      .contains('labels', JSON.stringify(clean))
      .not('key', 'is', null)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { key: string }[]).map((t) => ({ key: t.key, spaceId }));
  }

  /** Tasks of a space the invoker may view, by key or summary, for the parent picker (B2). */
  async searchParentTasks(
    batch: AgentResolveBatch,
    spaceId: string,
    query: string,
  ): Promise<AgentFieldOption[]> {
    if (!(await this.canViewTasks(batch, spaceId))) return [];
    let q = this.client
      .from('tasks')
      .select('id, key, summary')
      .eq('organization_id', batch.invoker.organizationId)
      .eq('space_id', spaceId)
      .not('key', 'is', null);
    const term = query.trim().replace(/[%_\\,()]/g, '');
    if (term) q = q.or(`key.ilike.%${term}%,summary.ilike.%${term}%`);
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(10);
    if (error) throw new Error(error.message);
    return ((data ?? []) as { id: string; key: string; summary: string }[]).map((t) => ({
      value: t.id,
      label: t.summary,
      hint: t.key,
    }));
  }

  /** An open page under the same parent with a similar title, that the invoker can view (ROB-11 hint). */
  private async similarPage(
    batch: AgentResolveBatch,
    spaceId: string,
    parentId: string | null,
    title: string,
  ): Promise<{ id: string; title: string } | null> {
    const matches = await this.memo(batch, `similar:${spaceId}:${parentId}:${nameKey(title)}`, () =>
      this.runs
        .findSimilar({
          organizationId: batch.invoker.organizationId,
          entityType: 'wiki_page',
          spaceIds: [spaceId],
          title,
          scopeId: parentId,
          limit: 5,
        })
        .catch(() => []),
    );
    for (const m of matches) {
      if (!this.wikiPermissions) break;
      try {
        await this.wikiPermissions.assertPageAccess(m.entity_id, batch.invoker.userId, spaceId, 'can_view');
      } catch {
        continue;
      }
      const { data } = await this.client
        .from('wiki_pages')
        .select('id, title')
        .eq('id', m.entity_id)
        .eq('organization_id', batch.invoker.organizationId)
        .maybeSingle();
      if (data) return data as { id: string; title: string };
    }
    return null;
  }
}
