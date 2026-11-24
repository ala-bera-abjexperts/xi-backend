/**
 * @fileoverview Shared helpers for Phase 4+ stage handlers.
 *
 * The target space's crosswalk row is keyed by the JOB's `source_ref` (the Jira
 * project key) — known to every stage without extra source calls; the numeric
 * project id lives in the row's metadata.
 */

import {
  MigrationItemError,
  type ItemOutcome,
  type StageContext,
} from './stage.interface';

export const SPACE_ENTITY = 'space';

/**
 * Resolve the run's target space id via the crosswalk, or `null` when the space
 * stage hasn't landed yet (caller returns a blocked outcome). In dry-run, a
 * `planned` space row gates open but carries no real id — callers must treat
 * `dryRunPlanned` as "gate open, no writes".
 */
export async function resolveTargetSpace(
  ctx: StageContext,
): Promise<{ spaceId: string | null; gateOpen: boolean }> {
  const row = await ctx.entityMap.getTarget(
    ctx.orgId,
    ctx.job.connection_id,
    SPACE_ENTITY,
    ctx.job.source_ref,
  );

  if (!row) return { spaceId: null, gateOpen: false };

  if (row.status === 'mapped')
    return { spaceId: row.target_id, gateOpen: true };

  if (row.status === 'planned' && ctx.dryRun)
    return { spaceId: null, gateOpen: true };

  return { spaceId: null, gateOpen: false };
}

/** Blocked outcome pointing at the space gate (cross-entity-type, so not the worker's generic gate). */
export function blockedOnSpace(ctx: StageContext): ItemOutcome {
  return {
    kind: 'blocked',
    waitingFor: { entityType: SPACE_ENTITY, sourceId: ctx.job.source_ref },
  };
}

export interface RunJobOptions {
  macro_strategy?: 'semantic' | 'fallback';
  batch_size?: number;
  user_mapping?: string;
  /**
   * Users stage: create a real XISUITE account for every source user who has a usable email and no
   * existing account, and mail them a set-password link. OFF by default — it is outward-facing and
   * irreversible (real logins, one message per user through the customer's own relay), so it must
   * be chosen deliberately after reviewing the dry-run preview's `wouldCreate` list.
   */
  provision_users?: boolean;
  /**
   * Users stage: invite every unmatched source user with a usable email to the org, with the org role
   * their Jira admin-group membership implies. OFF by default for the same reason as `provision_users`
   * (one message per user); accepting the invite claims their placeholder (XE-T682).
   */
  invite_users?: boolean;
}

/** The scope the admin selected in the wizard (`migration_jobs.scope`). */
export interface RunJobScope {
  issue_type_ids?: string[];
  include_boards?: boolean;
  include_comments?: boolean;
  include_attachments?: boolean;
  include_links?: boolean;
  /** JQL narrowing which issues migrate; the adapter's project filter is the fallback. */
  jql?: string;
  /**
   * Groups stage: import EVERY group the picker returns, not just role-actor groups. Off by
   * default because a real instance's picker holds hundreds of groups unrelated to the project.
   */
  include_all_groups?: boolean;
}

/**
 * The job scope FROZEN into the run at start (`run.config_snapshot.scope`) — never the live
 * `migration_jobs` row, for exactly the reason `runOptions` gives below: the worker reloads jobs
 * each pass, so reading `ctx.job.scope` lets a mid-run PATCH change behaviour between stages and
 * makes a run unreproducible from its own snapshot. Falls back to the live row only if a legacy run
 * froze no scope.
 */
export function runScope(ctx: StageContext): RunJobScope {
  const snapshot = (ctx.run.config_snapshot ?? {}) as { scope?: RunJobScope };

  return snapshot.scope ?? ((ctx.job.scope ?? {}) as RunJobScope);
}

/**
 * Whether an optional slice is included. The wizard's `include_*` flags are REQUIRED booleans on the
 * DTO, but a legacy job (or a scope frozen before the flag existed) may omit them — and defaulting a
 * missing flag to `false` would silently skip data the admin never chose to exclude. Absent = include.
 */
export function scopeIncludes(
  ctx: StageContext,
  key:
    | 'include_boards'
    | 'include_comments'
    | 'include_attachments'
    | 'include_links',
): boolean {
  return runScope(ctx)[key] !== false;
}

/**
 * The job options FROZEN into the run at start (`run.config_snapshot.options`) — never the live
 * `migration_jobs` row. The worker loads jobs fresh each pass, so reading `ctx.job.options` let a
 * mid-run PATCH change behaviour between stages (e.g. `pages` renders native tables while a later
 * `page_relink` re-renders the same pages list-degraded), making a run unreproducible from its own
 * snapshot. Falls back to the live row only if a legacy run froze no options.
 */
export function runOptions(ctx: StageContext): RunJobOptions {
  const snapshot = (ctx.run.config_snapshot ?? {}) as {
    options?: RunJobOptions;
  };

  return snapshot.options ?? ((ctx.job.options ?? {}) as RunJobOptions);
}

/** The user who started the run — required for created_by/added_by on reuse-service writes. */
export function requireActingUser(ctx: StageContext): string {
  if (!ctx.run.created_by) {
    throw new MigrationItemError(
      'permanent',
      'Run has no creator to attribute writes to',
    );
  }

  return ctx.run.created_by;
}

/**
 * True when the job names a target space that differs from the one the crosswalk already maps
 * this source to — meaning the space stage must adopt the job's choice instead of short-circuiting
 * on the older mapping.
 *
 * `migration_entity_map` is unique on (organization_id, source_connection_id, entity_type,
 * source_id) — the TARGET is not part of the key. So a source migrated once through a connection
 * keeps its original mapping forever, and without this check an explicit `target_space_id` is
 * silently ignored: the operator picks a space, the job card reads "Target space linked", and every
 * stage still writes into the space the first run created. Observed live on XE-T549 — a Jira KAN
 * run targeted at a fresh space put all 55 issues into the "KANBAN (2)" space an earlier run made,
 * and still reported `succeeded`.
 *
 * Equal ids must return false: that is the idempotent re-run path and has to stay a no-op.
 */
export function targetOverridesMappedSpace(
  jobTargetSpaceId: string | null | undefined,
  existingTargetId: string | null | undefined,
): boolean {
  if (!jobTargetSpaceId || !existingTargetId) return false;

  return jobTargetSpaceId !== existingTargetId;
}
