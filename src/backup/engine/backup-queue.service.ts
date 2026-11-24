/**
 * @fileoverview Typed wrappers over the two claim RPCs.
 * @module src/backup/engine/backup-queue.service
 *
 * Both wrappers degrade instead of throwing when the RPC is absent. The migration is applied by a
 * human, possibly after this code ships, and the repo's migrations already drift from the running
 * database — so "function does not exist" is an expected boot state, not a crash.
 *
 * The warning is latched. A thirty-second tick that logs on every miss writes 2,880 identical lines
 * a day, which is how a real error becomes invisible.
 */

import { Injectable, Logger } from '@nestjs/common';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { ITEM_CLAIM_LIMIT, SCHEME_CLAIM_LIMIT } from '../backup.constants';

export interface DueScheme {
  scheme_id: string;
  organization_id: string;
  /** When the run was DUE — not the new next_run_at, which the claim already advanced. */
  due_at: string;
}

export interface LeasedItem {
  id: string;
  organization_id: string;
  tier: string;
  component_key: string;
  table_name: string | null;
  item_kind: string;
  sequence: number;
  checkpoint: Record<string, unknown> | null;
  retry_count: number;
}

interface RpcError {
  message?: string;
  code?: string;
}

@Injectable()
export class BackupQueueService {
  private readonly logger = new Logger(BackupQueueService.name);
  private missingRpcLogged = new Set<string>();

  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  private get db() {
    return this.supabaseAdmin.getClient();
  }

  /** True when the failure is "this RPC has not been created yet". */
  private isMissingRpc(error: RpcError): boolean {
    const message = error.message ?? '';

    return (
      error.code === 'PGRST202' ||
      error.code === '42883' ||
      /does not exist/i.test(message) ||
      /could not find the function/i.test(message)
    );
  }

  private handleRpcError(name: string, error: RpcError): void {
    if (this.isMissingRpc(error)) {
      if (!this.missingRpcLogged.has(name)) {
        this.missingRpcLogged.add(name);
        this.logger.warn(
          `${name} is not present yet — backup scheduling is idle until the migration is applied`,
        );
      }

      return;
    }

    this.logger.error(`${name} failed: ${error.message ?? 'unknown error'}`);
  }

  /**
   * Atomically leases the schemes that are due.
   *
   * The RPC also advances `next_run_at` by a short provisional amount inside the same statement, so
   * a worker that dies before writing the real value costs one retry rather than an endless loop.
   */
  async claimDueSchemes(
    workerId: string,
    leaseMs: number,
    limit: number = SCHEME_CLAIM_LIMIT,
  ): Promise<DueScheme[]> {
    const { data, error } = (await this.db.rpc('claim_due_backup_schemes', {
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_duration_ms: leaseMs,
    })) as unknown as { data: DueScheme[] | null; error: RpcError | null };

    if (error) {
      this.handleRpcError('claim_due_backup_schemes', error);

      return [];
    }

    return data ?? [];
  }

  async leaseRunItems(
    runId: string,
    workerId: string,
    leaseMs: number,
    limit: number = ITEM_CLAIM_LIMIT,
  ): Promise<LeasedItem[]> {
    const { data, error } = (await this.db.rpc('lease_backup_run_items', {
      p_run_id: runId,
      p_worker_id: workerId,
      p_limit: limit,
      p_lease_duration_ms: leaseMs,
    })) as unknown as { data: LeasedItem[] | null; error: RpcError | null };

    if (error) {
      this.handleRpcError('lease_backup_run_items', error);

      return [];
    }

    return data ?? [];
  }
}
