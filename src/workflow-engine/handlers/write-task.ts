import { ConflictException } from '@nestjs/common';
import type { IEvaluationContext } from './handler.types';

/** Same-task writes carry the durable operation token; linked tasks keep their own writes. */
export async function writeWorkflowTask(ctx: IEvaluationContext, patch: Record<string, unknown>): Promise<{data: unknown; error: null}> {
  if (!ctx.txn || !ctx.taskId) throw new ConflictException('Missing workflow task context');
  const result = ctx.workflowToken
    ? await ctx.txn.rpc('sla_write_workflow_task', {
        p_task_id: ctx.taskId, p_token: ctx.workflowToken, p_patch: patch,
      })
    : await ctx.txn.from('tasks').update(patch).eq('id', ctx.taskId).eq('organization_id', ctx.organizationId);
  if (result.error) throw new ConflictException(result.error.message);
  return result;
}
