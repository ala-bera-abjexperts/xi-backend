/**
 * @fileoverview Local forward-declared contract for the workflow runtime engine.
 *
 * Phase L (this module) needs to invoke `engine.executeTransition(...)` from the
 * inbound webhook path, but Phase B+C-E (which actually build the engine
 * service) have not yet landed. To keep this module independently compilable
 * and unit-testable we:
 *   - Declare the minimal call-shape we depend on as {@link IWorkflowEngineRuntime}.
 *   - Expose a DI token {@link WORKFLOW_ENGINE_SERVICE} so the engine module
 *     (when it lands) can register its implementation under the same token.
 *   - Inject via `@Optional()` so boot succeeds even when the engine is not yet
 *     registered, and the inbound path falls through to a clear 503.
 *
 * When the real `WorkflowEngineService` class lands in Phase B, it should be
 * registered as `{ provide: WORKFLOW_ENGINE_SERVICE, useExisting: WorkflowEngineService }`
 * (or `useClass`) from inside `WorkflowEngineModule.exports`.
 *
 * @module src/workflow-triggers/workflow-engine.contract
 * @author Rajbha Manek
 */

import type { RequestUser } from '../auth/interfaces/request-user.interface';

/**
 * Minimal call-shape the trigger module depends on from the workflow engine.
 * Phase B's concrete `WorkflowEngineService` MUST be assignable to this
 * interface — keep the surface area here tight.
 */
export interface IWorkflowEngineRuntime {
  /**
   * Execute a single workflow transition end-to-end (conditions → screen
   * input merge → validators → post-functions → status mutation → audit).
   * The trigger module synthesizes a {@link RequestUser} from the trigger
   * config or workflow `created_by` and forwards the inbound payload as
   * the screen-input.
   */
  executeTransition(args: {
    taskId: string;
    transitionId: string;
    screenInput: Record<string, unknown>;
    user: RequestUser;
    executionId: string;
  }): Promise<unknown>;
}

/**
 * DI token under which Phase B registers its `WorkflowEngineService`.
 * Using a Symbol keeps the trigger module free of any compile-time
 * dependency on the engine class.
 */
export const WORKFLOW_ENGINE_SERVICE = Symbol('WORKFLOW_ENGINE_SERVICE');
