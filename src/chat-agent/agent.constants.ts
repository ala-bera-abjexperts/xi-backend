/**
 * @fileoverview The fixed values of Robert, the AI assistant in chat (XE-T353, contract
 * section 1). The frontend (`src/models/robert.model.ts`) and the database functions
 * (20261014130100_chat_agent_functions.sql) use the same values.
 * Imports nothing, so the chat module can read it without importing ChatAgentModule.
 * @module src/chat-agent/agent.constants
 */

/** Robert's id. Never a `users` row. */
export const ROBERT_ID = '0b3e7000-0000-4000-8000-000000000001';

/** His name in every language; also the `data-user-name` of his mention node. */
export const ROBERT_NAME = 'Robert';

/**
 * Whether a DM key belongs to someone's private conversation with Robert:
 * `least(user, ROBERT_ID) || ':' || greatest(user, ROBERT_ID)`, a `dm` with ONE member.
 */
export function isAgentDmKey(dmKey: string | null | undefined): boolean {
  return !!dmKey && dmKey.split(':').includes(ROBERT_ID);
}

// Limits
export const MAX_CONTEXT_MESSAGES = 50;
export const MAX_CONTEXT_MESSAGE_CHARS = 2_000;
/** All context text of one run (about 10k tokens), so a long history never outgrows the reservation. */
export const MAX_CONTEXT_CHARS = 40_000;
export const MAX_ACTIONS_PER_RUN = 50;
export const MAX_MODEL_CALLS_PER_RUN = 8;
export const MAX_RUNS_PER_USER_PER_MINUTE = 6;
export const MAX_RUNNING_RUNS_PER_TENANT = 20;

// Times, in milliseconds. Expiry, undo window and lease length are enforced by the
// database functions; the backend only needs them to plan its own timers.
export const PROPOSAL_EXPIRY_MS = 24 * 60 * 60_000;
export const UNDO_WINDOW_MS = 10 * 60_000;
/**
 * One model call is aborted after this long, progress or not: the answer does not stream. A plan
 * of 50 items with a wiki page takes about four minutes; the run's own deadline (SQL) still caps it.
 */
export const MODEL_CALL_IDLE_TIMEOUT_MS = 280_000;
export const RUN_DEADLINE_MS = 300_000;
export const LEASE_MS = 30_000;
export const LEASE_RENEW_MS = 5_000;
export const SWEEP_INTERVAL_MS = 15_000;

/**
 * Tokens reserved for one run when it starts. Also the smallest cap an admin may set.
 * ponytail: a fixed estimate per run; reserve from the prompt size when runs differ a lot.
 */
export const RUN_RESERVE_TOKENS = 60_000;

// Output limits per model call
export const PLAN_MAX_OUTPUT_TOKENS = 28_000;
export const ASSET_FILL_MAX_OUTPUT_TOKENS = 4_000;

let workerEnabled: boolean | undefined;

/**
 * `ROBERT_WORKER_ENABLED=false` → this instance never claims or runs a run (default on),
 * so a developer machine on a shared database never sends tenant prompts.
 * Read once, on first use and not at import: ConfigModule copies `.env` into
 * `process.env` only after this file has been loaded.
 */
export function isRobertWorkerEnabled(): boolean {
  return (workerEnabled ??= process.env.ROBERT_WORKER_ENABLED !== 'false');
}
