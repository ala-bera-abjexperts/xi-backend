import { writeWorkflowTask } from '../write-task';
/**
 * @fileoverview Post-function: clears the task's resolution and resolved_at
 * timestamp. Scoped by id + organization_id to stay safe under the engine's
 * relaxed-atomicity model.
 * @module src/workflow-engine/handlers/post-functions/clear-resolution.post
 * @author Rajbha Manek
 */

import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type {
  IPostFunctionHandler,
  IEvaluationContext,
  IRuleReference,
} from '../handler.types';

const cfgSchema = z.object({
  type: z.literal('clear_resolution'),
});

export type ClearResolutionConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class ClearResolutionPostFunction implements IPostFunctionHandler<ClearResolutionConfig> {
  readonly type = 'clear_resolution';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  async run(
    _cfg: ClearResolutionConfig,
    ctx: IEvaluationContext,
  ): Promise<void> {
    if (!ctx.txn) {
      throw new BadRequestException('clear_resolution requires ctx.txn');
    }
    if (!ctx.taskId) {
      throw new BadRequestException('clear_resolution requires ctx.taskId');
    }

    await writeWorkflowTask(ctx, { resolution_id: null, resolved_at: null });
  }

  findReferences(cfg: ClearResolutionConfig): IRuleReference[] {
    void cfg;

    return [];
  }
}
