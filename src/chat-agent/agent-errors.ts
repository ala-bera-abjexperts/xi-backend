/**
 * @fileoverview How a failed Robert run ends (plan 2g): the failure code shown to the user,
 * whether the card offers Retry (contract section 5) and whether Robert's managers get the
 * "provider problem" bell. Pure; the worker calls it once per run, after its own retries.
 * @module src/chat-agent/agent-errors
 */
import {
  TenantAiError,
  type TenantAiErrorKind,
} from '../ai-automation/tenant-ai.service';
import type { AgentFailureCode } from './agent-runs.repository';

export type RunErrorOutcome =
  | { status: 'cancelled' }
  | {
      status: 'failed';
      code: AgentFailureCode;
      retryable: boolean;
      notifyAdmins: boolean;
    };

const CODE_BY_KIND: Record<
  Exclude<TenantAiErrorKind, 'cancelled'>,
  AgentFailureCode
> = {
  auth: 'invalid_key',
  quota: 'invalid_key',
  not_configured: 'invalid_key',
  rate_limited: 'rate_limited',
  provider_down: 'provider_down',
  timeout: 'timeout',
  too_large: 'too_large',
  invalid_output: 'failed',
  refused: 'failed',
  model_not_found: 'failed',
  bad_request: 'failed',
};

// Node's fetch (undici) and socket errors: "fetch failed" with a cause carrying ECONNRESET,
// ENOTFOUND, UND_ERR_CONNECT_TIMEOUT and the like.
const NETWORK_CODE = /^(E[A-Z]+|UND_ERR_[A-Z_]+)$/;

function isNetworkError(err: unknown): boolean {
  for (let e = err, depth = 0; e && depth < 3; depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && NETWORK_CODE.test(code)) return true;
    if (message === 'fetch failed') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A Stop wins over whatever error the abort caused, so it is never shown as a timeout.
 * Anything that is neither a TenantAiError nor a network error (a schema mismatch, a bug)
 * is `failed`.
 */
export function classifyRunError(
  err: unknown,
  { aborted }: { aborted: boolean },
): RunErrorOutcome {
  if (aborted) return { status: 'cancelled' };
  let code: AgentFailureCode;
  if (err instanceof TenantAiError) {
    if (err.kind === 'cancelled') return { status: 'cancelled' };
    code = CODE_BY_KIND[err.kind];
  } else {
    code = isNetworkError(err) ? 'provider_down' : 'failed';
  }
  return {
    status: 'failed',
    code,
    retryable: code !== 'invalid_key',
    notifyAdmins: code === 'invalid_key',
  };
}

/** Whether the worker may try the same model call again (1, 3, 9 s back-off). */
export function isRetryableAttempt(kind: TenantAiErrorKind): boolean {
  return kind === 'rate_limited' || kind === 'provider_down';
}
