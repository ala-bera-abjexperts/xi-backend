/**
 * @fileoverview Shape of the on-prem update state (mirrors .update-state/state.json
 * written by the deploy-side update-agent.sh) and the log-chunk returned by the
 * updater sidecar's /logs endpoint.
 * @module src/on-prem-updates/interfaces/update-state
 */

/** Canonical update lifecycle states (must match update-agent.sh / update-txn.sh). */
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'update_available'
  | 'no_update_available'
  | 'preflight_running'
  | 'backup_running'
  | 'backup_completed'
  | 'pulling_images'
  | 'applying_update'
  | 'running_migrations'
  | 'health_checking'
  | 'update_completed'
  | 'update_failed'
  | 'rollback_running'
  | 'rollback_completed'
  | 'rollback_failed'
  // backend / edge-case extensions
  | 'reconciling'
  | 'registry_unavailable'
  | 'registry_unauthorized'
  | 'deploy_unreachable'
  | 'db_partially_migrated'
  // DEPLOY_PLATFORM=kubernetes: the cluster (Helm/GitOps) owns upgrades; there is no sidecar.
  | 'managed_externally'
  // Server configuration jobs (update-agent.sh apply-config, job kind `config`).
  | 'config_applying'
  | 'config_applied'
  | 'config_rolled_back'
  | 'config_failed';

export interface ImageVersion {
  ref?: string;
  digest?: string;
}

export interface UpdateAvailability {
  backend?: boolean;
  frontend?: boolean;
  any?: boolean;
}

export interface UpdateState {
  schema?: number;
  status: UpdateStatus;
  jobId?: string | null;
  kind?: 'update' | 'reinstall' | 'revert' | 'config' | null;
  currentVersions?: Record<string, ImageVersion>;
  targetVersions?: Record<string, unknown>;
  previousVersions?: Record<string, unknown>;
  updateAvailable?: UpdateAvailability;
  rollbackAvailable?: boolean;
  backupPath?: string | null;
  backupStatus?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  failedAt?: string | null;
  error?: string | null;
  logFile?: string | null;
  logBytes?: number;
  lastCheckedAt?: string | null;
  lastUpdateAt?: string | null;
  lastSuccessfulUpdate?: string | null;
  lastFailedUpdate?: string | null;
  release?: string;
  /** Backend-added: false when the sidecar could not be reached. */
  updaterReachable?: boolean;
}

export interface LogChunk {
  content: string;
  nextOffset: number;
  size: number;
}
