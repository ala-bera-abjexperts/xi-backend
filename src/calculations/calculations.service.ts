/**
 * @fileoverview Service for risk calculations via Supabase RPC functions.
 * Mirrors risk-management-app CalculationService — delegates to Supabase RPCs
 * for cascade calculations and uses calculation_results for caching.
 * @module src/calculations/calculations.service
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { AutomationEventOutboxService } from '../automations/automation-event-outbox.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { CalculateRiskDto } from './dto/calculate-risk.dto';
import type { RecalculateTreeDto } from './dto/recalculate-tree.dto';

const CACHE_TABLE = 'calculation_results';

/** Shape of a row from calculation_results. */
interface CacheRow {
  id: string;
  organization_id: string;
  business_process_id: string;
  calculated_values: unknown;
  calculation_metadata: unknown;
  calculated_at: string;
  expires_at: string;
}

@Injectable()
export class CalculationsService {
  private readonly logger = new Logger(CalculationsService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly outboxService?: AutomationEventOutboxService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /** Fires app.risk.threshold_crossed and app.risk.recalculated after a recalculation. */
  private async emitRiskEvent(orgId: string, processId: string): Promise<void> {
    try {
      const { data: proc } = await this.client
        .from('business_processes')
        .select('id, title, space_id, organization_id')
        .eq('id', processId)
        .maybeSingle();

      if (!proc) return;

      const { data: cached } = await this.client
        .from('calculation_results')
        .select('calculated_values')
        .eq('business_process_id', processId)
        .eq('organization_id', orgId)
        .order('calculated_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      const calcValues = cached?.calculated_values as Record<
        string,
        unknown
      > | null;

      // Derive a 0-100 scalar from the CIA dimensional values stored by the RPC.
      // The RPC stores a different field name per process type:
      //   Risiko           → total_risk        (aggregate of Assetbewertung children)
      //   Assetbewertung,
      //   Prozessbewertung,
      //   Servicebewertung,
      //   Geschäftsprozess → accumulated_risk  (aggregate of Schwachstelle children)
      //   Schwachstelle    → net_risk          (gross risk minus mitigation actions)
      //   Maßnahme         → action_values     (no risk score → riskScore stays null)
      // All risk objects have shape {c_p, c_i, i_p, i_i, a_p, a_i} with values 0-5.
      // Max raw sum = 6 × 5 = 30.  Normalize to 0-100 to match the threshold scale
      // shown to users in the automation trigger config (node-schema "0-100").
      const riskDimObj = (calcValues?.total_risk ??
        calcValues?.accumulated_risk ??
        calcValues?.net_risk) as Record<string, unknown> | null | undefined;

      const rawDimSum: number | null =
        riskDimObj && typeof riskDimObj === 'object'
          ? Object.values(riskDimObj).reduce<number>(
              (s, v) => s + (typeof v === 'number' ? v : 0),
              0,
            )
          : null;

      // Maßnahme processes (no risk object) yield null — skipped by matchesFilters.
      const riskScore: number | null =
        rawDimSum !== null
          ? Math.min(100, Math.round((rawDimSum / 30) * 100))
          : null;

      const typedProc = proc as Record<string, string>;
      const spaceId = typedProc.space_id;
      const payload = {
        process: {
          id: typedProc.id,
          name: typedProc.title,
          space_id: spaceId,
          organization_id: orgId,
          risk_score: riskScore,
        },
        riskScore,
      };

      void this.outboxService?.write(
        orgId,
        spaceId,
        'app.risk.threshold_crossed',
        payload,
      );
      void this.outboxService?.write(
        orgId,
        spaceId,
        'app.risk.recalculated',
        payload,
      );
    } catch (err) {
      this.logger.warn(
        `emitRiskEvent: failed to emit for process ${processId}: ${String(err)}`,
      );
    }
  }

  /**
   * Calculates risk for a business process (checks cache first).
   * Delegates to `calculate_risk_values_cascade` RPC.
   * `organization_id` is always taken from the JWT, never from the caller.
   */
  async calculateRisk(orgId: string, dto: CalculateRiskDto): Promise<unknown> {
    // Check cache first
    const cached = await this.getCachedResult(dto.process_id);
    if (cached !== null) return cached;

    const rpcResult = await this.client.rpc('calculate_risk_values_cascade', {
      p_process_id: dto.process_id,
      p_organization_id: orgId,
      p_cascade_to_parents: dto.cascade_to_parents ?? true,
    });

    if (rpcResult.error) {
      this.logger.error(
        'calculate_risk_values_cascade RPC failed:',
        rpcResult.error,
      );
      throw new BadRequestException(
        `Risk calculation failed: ${rpcResult.error.message}`,
      );
    }

    return rpcResult.data;
  }

  /**
   * Force-recalculates by clearing the cache first, then running the RPC.
   */
  async forceCalculateRisk(
    orgId: string,
    dto: CalculateRiskDto,
  ): Promise<unknown> {
    await this.clearProcessCache(dto.process_id, orgId);
    const result = await this.calculateRisk(orgId, dto);

    void this.emitRiskEvent(orgId, dto.process_id);

    return result;
  }

  /**
   * Recalculates an entire process tree bottom-up.
   * Delegates to `recalculate_tree_bottom_up` RPC.
   */
  async recalculateTree(
    orgId: string,
    dto: RecalculateTreeDto,
  ): Promise<unknown> {
    const treeResult = await this.client.rpc('recalculate_tree_bottom_up', {
      p_root_process_id: dto.root_process_id,
      p_organization_id: orgId,
    });

    if (treeResult.error) {
      this.logger.error(
        'recalculate_tree_bottom_up RPC failed:',
        treeResult.error,
      );
      throw new BadRequestException(
        `Tree recalculation failed: ${treeResult.error.message}`,
      );
    }

    void this.emitRiskEvent(orgId, dto.root_process_id);

    return treeResult.data;
  }

  /**
   * Clears the calculation cache for a process and its ancestors.
   * Delegates to `invalidate_calculation_cache_cascade` RPC.
   */
  async clearProcessCache(processId: string, orgId: string): Promise<void> {
    const { error } = await this.client.rpc(
      'invalidate_calculation_cache_cascade',
      {
        p_process_id: processId,
        p_organization_id: orgId,
      },
    );

    if (error) {
      this.logger.error(
        'invalidate_calculation_cache_cascade RPC failed:',
        error,
      );
      throw new BadRequestException(`Failed to clear cache: ${error.message}`);
    }
  }

  /**
   * Clears all calculation cache entries for the organization.
   * Returns the number of deleted rows.
   */
  async clearOrganizationCache(orgId: string): Promise<{ deleted: number }> {
    const { error, count } = await this.client
      .from(CACHE_TABLE)
      .delete({ count: 'exact' })
      .eq('organization_id', orgId);

    if (error) {
      this.logger.error('Failed to clear org cache:', error);
      throw new BadRequestException('Failed to clear organization cache');
    }

    return { deleted: count ?? 0 };
  }

  /**
   * Returns the cached calculation result for a process, or null if not found/expired.
   */
  async getCachedResult(processId: string): Promise<unknown> {
    const fetchResult = await this.client
      .from(CACHE_TABLE)
      .select('*')
      .eq('business_process_id', processId)
      .single();
    const row = fetchResult.data as CacheRow | null;

    if (fetchResult.error && fetchResult.error.code !== 'PGRST116') {
      this.logger.error('Failed to fetch cache:', fetchResult.error);
      return null;
    }

    if (!row) return null;

    // Auto-delete expired entries
    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      await this.client
        .from(CACHE_TABLE)
        .delete()
        .eq('business_process_id', processId);
      return null;
    }

    return row.calculated_values;
  }
}
