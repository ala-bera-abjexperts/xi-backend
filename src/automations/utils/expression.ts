// Requires: npm install jexl @types/jexl
import jexl from 'jexl';

// Side-effect import: registers the submission answer transforms on the shared jexl singleton.
import './submission-answers';

export interface EvalContext {
  trigger: unknown;
  nodes: Record<string, { output: unknown }>;
  context: Record<string, unknown>;
  customFields?: Record<string, unknown>;
}

/**
 * Evaluates a condition expression against the automation execution context.
 * Uses jexl for safe, sandboxed evaluation — no arbitrary code execution.
 *
 * Supported syntax:
 *   trigger.task.priority == 'high'
 *   nodes.n1.output.tokensUsed > 1000
 *   trigger.task.status != 'closed' and trigger.task.assigned_to != null
 */
export function evaluateExpression(expr: string, ctx: EvalContext): boolean {
  const evalFn = jexl.evalSync.bind(jexl) as (e: string, c: unknown) => unknown;
  const result: unknown = evalFn(expr, ctx);
  return Boolean(result);
}
