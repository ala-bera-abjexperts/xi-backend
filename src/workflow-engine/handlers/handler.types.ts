/**
 * @fileoverview Type definitions for the workflow rule handler registry.
 * @module src/workflow-engine/handlers/handler.types
 * @author Rajbha Manek
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';

export type RulePhase = 'condition' | 'validator' | 'post_function' | 'trigger';

export interface IRuleReference {
  kind:
    | 'field'
    | 'field_group'
    | 'user'
    | 'group'
    | 'role'
    | 'status'
    | 'resolution'
    | 'category'
    | 'permission';
  id: string;
}

export interface IEvaluationContext {
  organizationId: string;
  spaceId: string | null;
  taskId: string | null;
  task: Record<string, unknown> | null;
  transitionId: string;
  transition: Record<string, unknown> | null;
  userId: string | null;
  user: Record<string, unknown> | null;

  // Lookups for cheap evaluation
  userRoles: string[];
  userGroups: string[];
  customFieldValues: Record<string, unknown>;

  // Custom-field values re-keyed by field UUID (field_id). `customFieldValues`
  // stays keyed by slug (field_key) — as persisted in tasks.custom_field_values
  // and as consumed by comment/notification templates; this parallel map lets
  // field validators and field_equals/field_compare conditions look up by the
  // rule's field_id. Absent on hand-built test contexts, where readers fall
  // back to customFieldValues.
  customFieldValuesById?: Record<string, unknown>;

  // ---------------------------------------------------------------------
  // Runtime extensions (Prompt 6). All optional so v1 handlers compile
  // unchanged. The engine populates these when constructing the context
  // for executeTransition; condition-only callers (e.g. getAvailableTransitions)
  // leave them undefined.
  // ---------------------------------------------------------------------

  // Form values supplied by the user when the transition has a screen.
  // Populated AFTER conditions run but BEFORE validators run.
  screen_input?: Record<string, unknown>;

  // Status at the moment executeTransition was called. Null for initial
  // transitions (task was just created and has no prior status).
  from_status_id?: string | null;

  // Destination status_id after decision-resolution. Available to
  // post-functions only.
  to_status_id?: string;

  // The active workflow row in full (id, name, version, initial_status_id,
  // …). Handlers reading workflow metadata should prefer this over
  // re-querying.
  workflow?: Record<string, unknown>;

  // Idempotency key passed by the caller. Stored on the audit log row
  // (changes->>'execution_id') so re-runs return the cached result.
  execution_id?: string;

  // Recursion guard for update_linked_task → parent_transitioned cycles
  // (design Part 2.18). Starts at 0; engine increments on entry; refuses
  // when > 1.
  transition_depth?: number;

  // Supabase client for in-transaction reads/writes during a transition.
  // Post-functions use this for their side effects. NOT exposed to
  // conditions/validators (they read from ctx only).
  txn?: SupabaseClient;
  /** Durable same-task write fence, present only while a transition is pending. */
  workflowToken?: string;

  // Free-form additional context handlers may need
  extra?: Record<string, unknown>;
}

export interface IValidatorResult {
  ok: boolean;
  message?: string;
  fieldPath?: string;
}

export interface IBaseHandler<Cfg> {
  readonly type: string;
  readonly phase: RulePhase;
  readonly schema: z.ZodSchema<Cfg>;
  findReferences(cfg: Cfg): IRuleReference[];
}

export interface IConditionHandler<Cfg = unknown> extends IBaseHandler<Cfg> {
  readonly phase: 'condition';
  evaluate(cfg: Cfg, ctx: IEvaluationContext): Promise<boolean>;
}

export interface IValidatorHandler<Cfg = unknown> extends IBaseHandler<Cfg> {
  readonly phase: 'validator';
  validate(cfg: Cfg, ctx: IEvaluationContext): Promise<IValidatorResult>;
}

export interface IPostFunctionHandler<Cfg = unknown> extends IBaseHandler<Cfg> {
  readonly phase: 'post_function';
  // Stub in v1 — Prompt 6 implements runtime side-effects.
  run(cfg: Cfg, ctx: IEvaluationContext): Promise<void>;
}

export interface ITriggerHandler<Cfg = unknown> extends IBaseHandler<Cfg> {
  readonly phase: 'trigger';
  // Some triggers are stubs in v1. The stub implementation throws inside subscribe().
  subscribe(cfg: Cfg, ctx: IEvaluationContext): Promise<void>;
  unsubscribe(cfg: Cfg, ctx: IEvaluationContext): Promise<void>;
}

export type AnyHandler =
  | IConditionHandler
  | IValidatorHandler
  | IPostFunctionHandler
  | ITriggerHandler;

// DI token for the array of registered handler instances. Module providers
// register handlers under this token; HandlerRegistryService consumes them.
export const WORKFLOW_HANDLERS = Symbol('WORKFLOW_HANDLERS');
