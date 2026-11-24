/**
 * @fileoverview Trigger: fires when a parent task transitions to a configured
 * status (or any status within a configured workflow). Subscribe/unsubscribe
 * are intentional no-op stubs (they throw `not implemented in v1`) — runtime
 * delivery is centralised in `WorkflowTriggerRegistryService`, which listens
 * for `task.transitioned` events and fans them out to matching child tasks.
 * Keeping subscribe out of the handler avoids per-trigger event-listener
 * bookkeeping and lets cache invalidation happen via `workflow.published`.
 * @module src/workflow-engine/handlers/triggers/parent-transitioned.trigger
 * @author Rajbha Manek
 */

import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IEvaluationContext,
  IRuleReference,
  ITriggerHandler,
} from '../handler.types';

const cfgSchema = z
  .object({
    type: z.literal('parent_transitioned'),
    parent_status_id: z.string().uuid().optional(),
    parent_workflow_id: z.string().uuid().optional(),
    // When set, each child is moved to THIS status via its own workflow
    // (resolved by WorkflowTriggerRegistryService). When omitted, the trigger
    // re-runs the parent's own transition on the child (legacy behaviour).
    child_target_status_id: z.string().uuid().optional(),
  })
  .refine(
    (c) =>
      c.parent_status_id !== undefined || c.parent_workflow_id !== undefined,
    {
      message: 'Specify parent_status_id or parent_workflow_id',
    },
  );

export type ParentTransitionedConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class ParentTransitionedTrigger implements ITriggerHandler<ParentTransitionedConfig> {
  readonly type = 'parent_transitioned';
  readonly phase = 'trigger' as const;
  readonly schema = cfgSchema;

  subscribe(
    cfg: ParentTransitionedConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('parent_transitioned subscribe runtime not implemented in v1'),
    );
  }

  unsubscribe(
    cfg: ParentTransitionedConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    void cfg;
    void ctx;
    return Promise.reject(
      new Error('parent_transitioned subscribe runtime not implemented in v1'),
    );
  }

  findReferences(cfg: ParentTransitionedConfig): IRuleReference[] {
    // Prompt 10 linter will check parent_workflow_id; for now we only track the
    // child target status so ref/cleanup tooling sees it.
    return cfg.child_target_status_id
      ? [{ kind: 'status', id: cfg.child_target_status_id }]
      : [];
  }
}
