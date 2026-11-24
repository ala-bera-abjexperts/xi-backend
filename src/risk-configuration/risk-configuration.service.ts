/**
 * @fileoverview Service for organization risk configuration — probability/impact mappings
 * and GREEN/ORANGE/RED thresholds. Mirrors risk-management-app RiskConfigurationService.
 * @module src/risk-configuration/risk-configuration.service
 */

import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import type { UpdateRiskConfigurationDto } from './dto/update-risk-configuration.dto';

const TABLE = 'risk_configurations';

const DEFAULT_CONFIG = {
  probability_mappings: { '1': 0.005, '2': 0.055, '3': 0.2, '4': 0.65 },
  impact_mappings: {
    '1': 961.54,
    '2': 10576.92,
    '3': 105769.23,
    '4': 855769.23,
  },
  threshold_green: 1000,
  threshold_orange: 10000,
};

/** Shape of a row from risk_configurations. */
interface RiskConfigRow {
  id: string;
  organization_id: string;
  probability_mappings: Record<string, number>;
  impact_mappings: Record<string, number>;
  threshold_green: number;
  threshold_orange: number;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class RiskConfigurationService {
  private readonly logger = new Logger(RiskConfigurationService.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogsService?: AuditLogsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  /**
   * Returns the organization's risk configuration.
   * Creates the default configuration if no record exists.
   */
  async getConfiguration(orgId: string): Promise<RiskConfigRow> {
    const fetchResult = await this.client
      .from(TABLE)
      .select('*')
      .eq('organization_id', orgId)
      .single();
    const existing = fetchResult.data as RiskConfigRow | null;

    if (fetchResult.error && fetchResult.error.code !== 'PGRST116') {
      this.logger.error('Failed to fetch risk config:', fetchResult.error);
      throw new BadRequestException('Failed to fetch risk configuration');
    }

    if (!existing) {
      return this.createDefault(orgId);
    }

    return existing;
  }

  /**
   * Updates the organization's risk configuration.
   * Validates threshold_green < threshold_orange when both are provided.
   */
  async updateConfiguration(
    orgId: string,
    dto: UpdateRiskConfigurationDto,
    actorUserId?: string | null,
  ): Promise<RiskConfigRow> {
    // Fetch current to check existence and merge thresholds
    const current = await this.getConfiguration(orgId);

    const newGreen = dto.threshold_green ?? current.threshold_green;
    const newOrange = dto.threshold_orange ?? current.threshold_orange;

    if (newGreen >= newOrange) {
      throw new BadRequestException(
        'threshold_green must be less than threshold_orange',
      );
    }

    const updateResult = await this.client
      .from(TABLE)
      .update({
        ...dto,
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .select()
      .single();
    const updated = updateResult.data as RiskConfigRow | null;

    if (updateResult.error || !updated) {
      this.logger.error('Failed to update risk config:', updateResult.error);
      throw new BadRequestException('Failed to update risk configuration');
    }

    this.logAudit(
      orgId,
      actorUserId,
      updated.id,
      'update',
      dto as Record<string, unknown>,
    );

    return updated;
  }

  /**
   * Resets the organization's risk configuration to defaults.
   */
  async resetToDefaults(
    orgId: string,
    actorUserId?: string | null,
  ): Promise<RiskConfigRow> {
    await this.getConfiguration(orgId);

    const updateResult = await this.client
      .from(TABLE)
      .update({
        ...DEFAULT_CONFIG,
        updated_at: new Date().toISOString(),
      })
      .eq('organization_id', orgId)
      .select()
      .single();
    const updated = updateResult.data as RiskConfigRow | null;

    if (updateResult.error || !updated) {
      this.logger.error('Failed to reset risk config:', updateResult.error);
      throw new BadRequestException('Failed to reset risk configuration');
    }

    this.logAudit(orgId, actorUserId, updated.id, 'restore', {
      reset_to_defaults: true,
    });
    return updated;
  }

  /**
   * Calculates the financial risk value for a given probability and impact level.
   */
  async calculateFinancialRisk(
    orgId: string,
    probability: number,
    impact: number,
  ): Promise<{ value: number }> {
    const config = await this.getConfiguration(orgId);
    const probValue = config.probability_mappings[probability.toString()] ?? 0;
    const impactValue = config.impact_mappings[impact.toString()] ?? 0;
    return { value: probValue * impactValue };
  }

  /**
   * Returns GREEN/ORANGE/RED level for a given financial risk value.
   */
  async getRiskLevel(
    orgId: string,
    value: number,
  ): Promise<{ level: 'GREEN' | 'ORANGE' | 'RED' }> {
    const config = await this.getConfiguration(orgId);
    let level: 'GREEN' | 'ORANGE' | 'RED';

    if (value <= config.threshold_green) {
      level = 'GREEN';
    } else if (value <= config.threshold_orange) {
      level = 'ORANGE';
    } else {
      level = 'RED';
    }

    return { level };
  }

  /**
   * Returns the min/max ranges for each risk level based on the current thresholds.
   */
  async getRiskLevelRanges(orgId: string): Promise<{
    green: { min: number; max: number };
    orange: { min: number; max: number };
    red: { min: number; max: number };
  }> {
    const config = await this.getConfiguration(orgId);

    return {
      green: { min: 0, max: config.threshold_green },
      orange: {
        min: config.threshold_green + 0.01,
        max: config.threshold_orange,
      },
      red: { min: config.threshold_orange + 0.01, max: Infinity },
    };
  }

  // ── Private ───────────────────────────────────────────────────────────

  private async createDefault(orgId: string): Promise<RiskConfigRow> {
    const insertResult = await this.client
      .from(TABLE)
      .insert({ organization_id: orgId, ...DEFAULT_CONFIG })
      .select()
      .single();
    const inserted = insertResult.data as RiskConfigRow | null;

    if (insertResult.error || !inserted) {
      this.logger.error(
        'Failed to create default risk config:',
        insertResult.error,
      );
      throw new BadRequestException('Failed to create risk configuration');
    }

    return inserted;
  }

  private logAudit(
    organizationId: string,
    actorUserId: string | null | undefined,
    entityId: string,
    action: 'update' | 'restore',
    changes?: Record<string, unknown>,
  ): void {
    if (!actorUserId || !this.auditLogsService) return;
    void this.auditLogsService.logAction(
      organizationId,
      actorUserId,
      'risk_configuration',
      entityId,
      action,
      changes,
    );
  }
}
