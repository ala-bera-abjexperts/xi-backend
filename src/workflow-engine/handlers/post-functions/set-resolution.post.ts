import { writeWorkflowTask } from '../write-task';
/**
 * @fileoverview Post-function: sets the task's resolution to a specific value
 * and stamps `resolved_at = now()`. Performs a cross-org check against the
 * `resolutions` table first so an admin can't reference a resolution from
 * another tenant through a copied workflow JSON.
 * @module src/workflow-engine/handlers/post-functions/set-resolution.post
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
  type: z.literal('set_resolution'),
  resolution_id: z.string().uuid(),
});

export type SetResolutionConfig = z.infer<typeof cfgSchema>;

@Injectable()
export class SetResolutionPostFunction implements IPostFunctionHandler<SetResolutionConfig> {
  readonly type = 'set_resolution';
  readonly phase = 'post_function' as const;
  readonly schema = cfgSchema;

  async run(cfg: SetResolutionConfig, ctx: IEvaluationContext): Promise<void> {
    if (!ctx.txn) {
      throw new BadRequestException('set_resolution requires ctx.txn');
    }
    if (!ctx.taskId) {
      throw new BadRequestException('set_resolution requires ctx.taskId');
    }

    // Cross-org check: the resolution must belong to the same organization
    // as the executing context. Workflows can be cloned across orgs and
    // resolution UUIDs leak through if we don't check.
    const checkRes = await ctx.txn
      .from('resolutions')
      .select('id')
      .eq('id', cfg.resolution_id)
      .eq('organization_id', ctx.organizationId)
      .limit(1)
      .maybeSingle();

    if (checkRes.error) {
      throw new BadRequestException(
        `set_resolution resolution lookup failed: ${checkRes.error.message}`,
      );
    }
    if (!checkRes.data) {
      throw new BadRequestException(
        `set_resolution: resolution ${cfg.resolution_id} not found in org ${ctx.organizationId}`,
      );
    }

    await writeWorkflowTask(ctx, {
      resolution_id: cfg.resolution_id,
      resolved_at: new Date().toISOString(),
    });

  }

  findReferences(cfg: SetResolutionConfig): IRuleReference[] {
    return [{ kind: 'resolution', id: cfg.resolution_id }];
  }
}
