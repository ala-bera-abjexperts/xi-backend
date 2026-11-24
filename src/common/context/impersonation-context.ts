/**
 * @fileoverview Request-scoped impersonation audit context backed by Node's
 * built-in {@link AsyncLocalStorage}. Lets every audit write inside an
 * impersonation session automatically record the impersonating SA's real
 * `public.users.id` without threading the id through every service signature.
 * @module src/common/context/impersonation-context
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The per-request impersonation audit payload stored in the ALS. */
export interface ImpersonationAuditContext {
  impersonatedByUserId: string | null;
}

export const impersonationAls =
  new AsyncLocalStorage<ImpersonationAuditContext>();

/** Run `cb` with the given impersonation audit context active for all async continuations. */
export function runWithImpersonationContext<T>(
  ctx: ImpersonationAuditContext,
  cb: () => T,
): T {
  return impersonationAls.run(ctx, cb);
}

/** Current request's impersonating SA id, or null when not impersonating / outside a request. */
export function getImpersonatedByUserId(): string | null {
  return impersonationAls.getStore()?.impersonatedByUserId ?? null;
}
