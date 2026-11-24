/**
 * @fileoverview Service for heatmap configuration and data generation.
 * Ports business logic from risk-management-app HeatmapService and config routes.
 * @module src/heatmap/heatmap.service
 */

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { PermissionsService } from '../permissions/permissions.service';
import { CIARiskCalculator } from './utils/cia-risk-calculator';
import { HeatmapMatrix } from './utils/heatmap-matrix';
import { RiskColorService } from './utils/risk-color-service';
import type { HeatmapConfigDto } from './dto/heatmap-config.dto';
import type { GenerateHeatmapBodyDto } from './dto/generate-heatmap-body.dto';

const CONFIG_TABLE = 'heatmap_configurations';
const PROCESSES_TABLE = 'business_processes';

const DEFAULT_REQUEST_TYPES = [
  'Assetbewertung',
  'Schwachstelle',
  'Servicebewertung',
  'Prozessbewertung',
  'Geschäftsprozessbewertung',
  'Risiko',
];

/** Shape of a business process row as used by the heatmap. */
interface HeatmapProcess {
  id: string;
  title: string;
  description: string | null;
  request_type: string;
  vuln_c_p: number | null;
  vuln_c_i: number | null;
  vuln_i_p: number | null;
  vuln_i_i: number | null;
  vuln_a_p: number | null;
  vuln_a_i: number | null;
}

@Injectable()
export class HeatmapService {
  private readonly logger = new Logger(HeatmapService.name);
  private readonly ciaCalc = new CIARiskCalculator();
  private readonly colorSvc = new RiskColorService();

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private get client() {
    return this.supabaseAdmin.getClient();
  }

  // ── Heatmap Configuration ─────────────────────────────────────────────

  /**
   * Returns the organization's heatmap configuration.
   * If no custom config exists, returns the built-in default with `isDefault: true`.
   */
  async getConfig(
    orgId: string,
    userId?: string,
  ): Promise<{ config: Record<string, unknown>; isDefault: boolean }> {
    if (userId) {
      await this.assertCanViewHeatmap(orgId, userId);
    }

    const result = await this.client
      .from(CONFIG_TABLE)
      .select('*')
      .eq('organization_id', orgId)
      .single();

    if (result.error && result.error.code !== 'PGRST116') {
      this.logger.error('Failed to fetch heatmap config:', result.error);
      throw new BadRequestException('Failed to fetch heatmap configuration');
    }

    if (!result.data) {
      return { config: this.getDefaultConfig(orgId), isDefault: true };
    }

    return {
      config: result.data as Record<string, unknown>,
      isDefault: false,
    };
  }

  /**
   * Creates a new heatmap configuration for the organization.
   */
  async createConfig(
    orgId: string,
    userId: string,
    dto: HeatmapConfigDto,
  ): Promise<{ config: Record<string, unknown> }> {
    await this.assertCanManageHeatmapConfig(orgId, userId);

    const input = this.sanitizeConfigDto(dto);
    const result = await this.client
      .from(CONFIG_TABLE)
      .insert({
        organization_id: orgId,
        created_by: userId,
        updated_by: userId,
        ...input,
      })
      .select()
      .single();

    if (result.error || !result.data) {
      this.logger.error('Failed to create heatmap config:', result.error);
      throw new BadRequestException('Failed to create heatmap configuration');
    }

    void this.logAudit(
      orgId,
      userId,
      'create',
      result.data as Record<string, unknown>,
    );
    return { config: result.data as Record<string, unknown> };
  }

  /**
   * Upserts the organization's heatmap configuration (insert if not exists, update if exists).
   */
  async upsertConfig(
    orgId: string,
    userId: string,
    dto: HeatmapConfigDto,
  ): Promise<{ config: Record<string, unknown> }> {
    await this.assertCanManageHeatmapConfig(orgId, userId);

    const input = this.sanitizeConfigDto(dto);
    const result = await this.client
      .from(CONFIG_TABLE)
      .upsert(
        {
          organization_id: orgId,
          updated_by: userId,
          ...input,
        },
        { onConflict: 'organization_id' },
      )
      .select()
      .single();

    if (result.error || !result.data) {
      this.logger.error('Failed to upsert heatmap config:', result.error);
      throw new BadRequestException('Failed to update heatmap configuration');
    }

    void this.logAudit(
      orgId,
      userId,
      'update',
      result.data as Record<string, unknown>,
    );
    return { config: result.data as Record<string, unknown> };
  }

  /**
   * Deletes the custom configuration, effectively resetting to defaults.
   */
  async deleteConfig(
    orgId: string,
    userId?: string,
  ): Promise<{ success: true; message: string }> {
    if (userId) {
      await this.assertCanManageHeatmapConfig(orgId, userId);
    }

    const { error } = await this.client
      .from(CONFIG_TABLE)
      .delete()
      .eq('organization_id', orgId);

    if (error) {
      this.logger.error('Failed to delete heatmap config:', error);
      throw new BadRequestException('Failed to delete heatmap configuration');
    }

    if (userId) {
      void this.logAudit(orgId, userId, 'delete', { organization_id: orgId });
    }
    return { success: true, message: 'Configuration reset to default' };
  }

  // ── Heatmap Data Generation ───────────────────────────────────────────

  /**
   * Generates heatmap matrix data from business processes.
   * Matches risk-management-app HeatmapService.generateHeatmapData() exactly.
   */
  async generateHeatmapData(
    orgId: string,
    userIdOrConfig: string | GenerateHeatmapBodyDto,
    maybeConfig?: GenerateHeatmapBodyDto,
  ): Promise<Record<string, unknown>> {
    const { userId, config } = this.normalizeUserConfig(
      userIdOrConfig,
      maybeConfig,
    );

    // Resolve scope once. If userId is present, this also enforces permissions
    // (throws ForbiddenException on no access). If no userId, fall through to
    // legacy behavior (no filter).
    const accessibleSpaceIds = userId
      ? await this.resolveAccessibleSpaceFilter(orgId, userId, config.spaceId)
      : undefined;

    try {
      const matrixSize = config.matrixSize ?? 5;
      const processes = await this.fetchProcesses(
        orgId,
        config,
        accessibleSpaceIds,
      );

      const emptyMatrix = new HeatmapMatrix(matrixSize);
      if (!processes || processes.length === 0) {
        return {
          success: true,
          heatMapData: {
            matrix: emptyMatrix.getMatrix(),
            stats: {
              totalProcessed: 0,
              excludedCount: 0,
              maxCount: 0,
              filledCells: 0,
              emptyCells: matrixSize * matrixSize,
              averageProcessesPerCell: 0,
            },
          },
          configuration: config,
          metadata: {
            processedIssues: 0,
            generatedAt: new Date().toISOString(),
            organizationId: orgId,
          },
        };
      }

      const matrix = this.buildMatrix(processes, matrixSize);
      this.applyColors(matrix, config);
      this.applyIndividualCustomizations(matrix, config);
      const stats = matrix.getStatistics();

      return {
        success: true,
        heatMapData: { matrix: matrix.getMatrix(), stats },
        configuration: config,
        metadata: {
          processedIssues: stats.totalProcessed,
          generatedAt: new Date().toISOString(),
          organizationId: orgId,
        },
      };
    } catch (err) {
      this.logger.error('Error generating heatmap data:', err);
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error occurred',
      };
    }
  }

  private normalizeUserConfig(
    userIdOrConfig: string | GenerateHeatmapBodyDto,
    maybeConfig?: GenerateHeatmapBodyDto,
  ): { userId?: string; config: GenerateHeatmapBodyDto } {
    if (typeof userIdOrConfig === 'string') {
      return { userId: userIdOrConfig, config: maybeConfig ?? {} };
    }

    return { config: userIdOrConfig };
  }

  // ── Risk Summary ──────────────────────────────────────────────────────

  /**
   * Groups processes by maxProbability×maxImpact and returns a sorted risk summary.
   * Matches risk-management-app HeatmapService.getRiskSummary() exactly.
   */
  async getRiskSummary(
    orgId: string,
    userIdOrConfig:
      | string
      | {
          requestTypes?: string[];
          status?: string[];
          spaceId?: string;
        },
    maybeConfig?: {
      requestTypes?: string[];
      status?: string[];
      spaceId?: string;
    },
  ): Promise<{
    success: true;
    riskSummary: unknown[];
    totalRisks: number;
  }> {
    const { userId, config } = this.normalizeSummaryUserConfig(
      userIdOrConfig,
      maybeConfig,
    );

    // Resolve scope + permissions in one call (throws on no access).
    const accessibleSpaceIds = userId
      ? await this.resolveAccessibleSpaceFilter(orgId, userId, config.spaceId)
      : undefined;

    const processes = await this.fetchProcesses(
      orgId,
      config,
      accessibleSpaceIds,
    );

    const riskMap = new Map<string, HeatmapProcess[]>();

    processes.forEach((process) => {
      const ciaValues = this.ciaCalc.calculateCIAValues(process);
      if (ciaValues.maxProbability === 0 || ciaValues.maxImpact === 0) return;

      const key = `${ciaValues.maxProbability},${ciaValues.maxImpact}`;
      if (!riskMap.has(key)) riskMap.set(key, []);
      riskMap.get(key)!.push(process);
    });

    const riskSummary: unknown[] = [];

    riskMap.forEach((procs, key) => {
      const [probability, impact] = key.split(',').map(Number);
      const riskLevel = this.ciaCalc.calculateRiskLevel(probability, impact);

      riskSummary.push({
        key,
        maxProbability: probability,
        maxImpact: impact,
        grossProbability: probability,
        grossFinancialImpact: impact,
        riskLevel,
        issues: procs.map((p) => ({
          key: p.id,
          summary: p.title,
          description: p.description,
          requestType: p.request_type,
        })),
      });
    });

    const sorted = (
      riskSummary as { maxProbability: number; maxImpact: number }[]
    ).sort(
      (a, b) => b.maxProbability * b.maxImpact - a.maxProbability * a.maxImpact,
    );

    return { success: true, riskSummary: sorted, totalRisks: sorted.length };
  }

  // ── Private Helpers ───────────────────────────────────────────────────

  private normalizeSummaryUserConfig(
    userIdOrConfig:
      | string
      | {
          requestTypes?: string[];
          status?: string[];
          spaceId?: string;
        },
    maybeConfig?: {
      requestTypes?: string[];
      status?: string[];
      spaceId?: string;
    },
  ): {
    userId?: string;
    config: {
      requestTypes?: string[];
      status?: string[];
      spaceId?: string;
    };
  } {
    if (typeof userIdOrConfig === 'string') {
      return { userId: userIdOrConfig, config: maybeConfig ?? {} };
    }

    return { config: userIdOrConfig };
  }

  /**
   * Resolves what processes the user can see for the heatmap.
   * Returns:
   *   - null    → admin/org-wide; caller should NOT apply a space_id filter
   *   - [id]    → single-space scope (spaceId was provided and user has access)
   *   - [...]   → aggregate across the user's accessible spaces
   *
   * Throws ForbiddenException if the user has no access at all.
   *
   * This is the single source of truth for "what is the heatmap allowed to
   * see?" — used by both the data fetch path and the assertion-only path.
   */
  private async resolveAccessibleSpaceFilter(
    orgId: string,
    userId: string,
    spaceId?: string,
  ): Promise<string[] | null> {
    if (await this.permissionsService.isAdminOrOwner(userId, orgId)) {
      return spaceId ? [spaceId] : null;
    }

    if (spaceId) {
      const access = await this.permissionsService.getUserSpacePermissions(
        userId,
        orgId,
        spaceId,
      );
      if (access.isMember && access.permissions['view_dashboards'] === true) {
        return [spaceId];
      }
      throw new ForbiddenException('Insufficient heatmap permissions');
    }

    // No spaceId: aggregate path.
    if (
      await this.permissionsService.checkPermission(
        userId,
        orgId,
        'can_view_dashboards',
      )
    ) {
      return null;
    }

    const accessibleSpaceIds = await this.getAccessibleSpaceIdsForView(
      orgId,
      userId,
    );
    if (accessibleSpaceIds.length === 0) {
      throw new ForbiddenException('Insufficient heatmap permissions');
    }
    return accessibleSpaceIds;
  }

  /**
   * Returns the list of space IDs the user can view_dashboards in, across the
   * whole organization. Used when the heatmap is requested without a specific
   * spaceId and the caller is NOT an admin/owner and lacks org-level
   * can_view_dashboards permission. Empty array means "no access".
   *
   * Uses Promise.all to parallelize per-space permission resolution. For typical
   * orgs (≤20 spaces) this is fast; if we ever need to scale to 100+ spaces,
   * a bulk method on PermissionsService would be the optimization.
   */
  private async getAccessibleSpaceIdsForView(
    orgId: string,
    userId: string,
  ): Promise<string[]> {
    const { data: spaces, error } = await this.client
      .from('spaces')
      .select('id')
      .eq('organization_id', orgId);

    if (error) {
      this.logger.error('Failed to fetch spaces for access resolution:', error);
      return [];
    }
    if (!spaces || spaces.length === 0) return [];

    const ids = (spaces as Array<{ id: string }>).map((s) => s.id);
    const checks = await Promise.all(
      ids.map((id) =>
        this.permissionsService
          .getUserSpacePermissions(userId, orgId, id)
          .catch((err: unknown) => {
            this.logger.warn(
              `getUserSpacePermissions failed for space ${id}: ${String(err)}`,
            );
            return {
              isMember: false,
              permissions: {} as Record<string, boolean>,
            };
          }),
      ),
    );

    const accessible: string[] = [];
    ids.forEach((id, i) => {
      const access = checks[i];
      if (access.isMember && access.permissions['view_dashboards'] === true) {
        accessible.push(id);
      }
    });

    return accessible;
  }

  private async assertCanViewHeatmap(
    orgId: string,
    userId: string,
    spaceId?: string,
  ): Promise<void> {
    if (await this.permissionsService.isAdminOrOwner(userId, orgId)) return;

    if (spaceId) {
      const access = await this.permissionsService.getUserSpacePermissions(
        userId,
        orgId,
        spaceId,
      );
      if (access.isMember && access.permissions['view_dashboards'] === true) {
        return;
      }
      throw new ForbiddenException('Insufficient heatmap permissions');
    }

    if (
      await this.permissionsService.checkPermission(
        userId,
        orgId,
        'can_view_dashboards',
      )
    ) {
      return;
    }

    // Fallback: allow read access for users who can view dashboards in at
    // least one space. Used by the heatmap widget on space dashboards (which
    // requests no spaceId so it can aggregate across all accessible spaces).
    const accessibleSpaceIds = await this.getAccessibleSpaceIdsForView(
      orgId,
      userId,
    );
    if (accessibleSpaceIds.length > 0) return;

    throw new ForbiddenException('Insufficient heatmap permissions');
  }

  private async assertCanManageHeatmapConfig(
    orgId: string,
    userId: string,
  ): Promise<void> {
    if (await this.permissionsService.isAdminOrOwner(userId, orgId)) return;

    if (
      await this.permissionsService.checkPermission(
        userId,
        orgId,
        'can_edit_dashboards',
      )
    ) {
      return;
    }

    throw new ForbiddenException(
      'Insufficient heatmap configuration permissions',
    );
  }

  private async fetchProcesses(
    orgId: string,
    config: {
      requestTypes?: string[];
      status?: string[];
      spaceId?: string;
    },
    /**
     * Optional space-scope filter resolved upstream by
     * {@link resolveAccessibleSpaceFilter}:
     *   - `undefined` → legacy/no-user path: apply only `config.spaceId` if any
     *   - `null`      → admin/org-wide: do NOT apply any space_id filter
     *   - `[]`        → caller has no accessible spaces → return [] (no rows)
     *   - `[...]`     → constrain to these space IDs (single or aggregate)
     */
    accessibleSpaceIds?: string[] | null,
  ): Promise<HeatmapProcess[]> {
    let q = this.client
      .from(PROCESSES_TABLE)
      .select(
        'id, title, description, request_type, vuln_c_p, vuln_c_i, vuln_i_p, vuln_i_i, vuln_a_p, vuln_a_i',
      )
      .eq('organization_id', orgId);

    if (config.spaceId) {
      q = q.eq('space_id', config.spaceId);
    } else if (Array.isArray(accessibleSpaceIds)) {
      if (accessibleSpaceIds.length === 0) {
        // Caller is permission-resolved but has no accessible spaces — return
        // empty without hitting the DB.
        return [];
      }
      q = q.in('space_id', accessibleSpaceIds);
    }
    // accessibleSpaceIds === null or undefined → no IN filter
    // (admin / org-wide perm / legacy no-user path)

    const statusValues =
      config.status && config.status.length > 0 ? config.status : ['active'];
    q = q.in('status', statusValues);

    const requestTypes =
      config.requestTypes && config.requestTypes.length > 0
        ? config.requestTypes
        : DEFAULT_REQUEST_TYPES;
    q = q.in('request_type', requestTypes);

    const fetchResult = await q;

    if (fetchResult.error) {
      this.logger.error(
        'Failed to fetch processes for heatmap:',
        fetchResult.error,
      );
      throw new BadRequestException('Failed to fetch processes');
    }

    const rows = (fetchResult.data ?? []) as HeatmapProcess[];
    return rows.filter((p) => this.hasValidCIAValues(p));
  }

  private hasValidCIAValues(p: HeatmapProcess): boolean {
    return !!(
      (p.vuln_c_p && p.vuln_c_p > 0) ||
      (p.vuln_c_i && p.vuln_c_i > 0) ||
      (p.vuln_i_p && p.vuln_i_p > 0) ||
      (p.vuln_i_i && p.vuln_i_i > 0) ||
      (p.vuln_a_p && p.vuln_a_p > 0) ||
      (p.vuln_a_i && p.vuln_a_i > 0)
    );
  }

  private buildMatrix(
    processes: HeatmapProcess[],
    matrixSize: number,
  ): HeatmapMatrix {
    const matrix = new HeatmapMatrix(matrixSize);

    processes.forEach((process) => {
      try {
        const ciaValues = this.ciaCalc.calculateCIAValues(process);
        if (ciaValues.maxProbability === 0 || ciaValues.maxImpact === 0) {
          matrix.incrementExcluded();
          return;
        }

        const probability = Math.min(ciaValues.maxProbability, matrixSize);
        const impact = Math.min(ciaValues.maxImpact, matrixSize);
        matrix.addProcess(probability, impact, process);
      } catch (err) {
        matrix.incrementExcluded();
        this.logger.warn(`Error processing ${process.id}:`, err);
      }
    });

    return matrix;
  }

  private applyColors(
    matrix: HeatmapMatrix,
    config: { showIssueCount?: boolean },
  ): void {
    const matrixSize = matrix.getSize();

    for (let probability = 1; probability <= matrixSize; probability++) {
      for (let impact = 1; impact <= matrixSize; impact++) {
        const cell = matrix.getCell(probability, impact);
        if (!cell) continue;

        const color = this.colorSvc.getCellColor(probability, impact);
        const riskLevel = this.ciaCalc.calculateRiskLevel(probability, impact);

        let displayText = riskLevel;
        if (config.showIssueCount !== false && cell.count > 0) {
          displayText = `${riskLevel}\n${cell.count}`;
        }

        matrix.setCellProperties(probability, impact, {
          color,
          text: displayText,
        });
      }
    }
  }

  private applyIndividualCustomizations(
    matrix: HeatmapMatrix,
    config: {
      coloringMode?: string;
      individualCellColors?: Record<string, string>;
      individualCellTexts?: Record<string, string>;
      individualCellForegroundColors?: Record<string, string>;
    },
  ): void {
    if (config.coloringMode !== 'individual-cells') return;

    if (config.individualCellColors) {
      Object.entries(config.individualCellColors).forEach(
        ([cellKey, color]) => {
          const [probability, impact] = cellKey.split(',').map(Number);
          if (probability && impact) {
            matrix.setCellProperties(probability, impact, { color });
          }
        },
      );
    }

    if (config.individualCellTexts) {
      Object.entries(config.individualCellTexts).forEach(([cellKey, text]) => {
        const [probability, impact] = cellKey.split(',').map(Number);
        if (probability && impact) {
          matrix.setCellProperties(probability, impact, { text });
        }
      });
    }

    if (config.individualCellForegroundColors) {
      Object.entries(config.individualCellForegroundColors).forEach(
        ([cellKey, foregroundColor]) => {
          const [probability, impact] = cellKey.split(',').map(Number);
          if (probability && impact) {
            matrix.setCellProperties(probability, impact, { foregroundColor });
          }
        },
      );
    }
  }

  private getDefaultConfig(orgId: string): Record<string, unknown> {
    return {
      organization_id: orgId,
      title: 'ISMS Risk Assessment Matrix',
      show_issue_count: true,
      cell_font_size: 'medium',
      matrix_size: 5,
      status_filter: ['active'],
      request_types: DEFAULT_REQUEST_TYPES,
      color_scheme: 'risk',
      custom_colors: ['#4caf50', '#8bc34a', '#ffeb3b', '#ff9800', '#f44336'],
      use_custom_colors: false,
      coloring_mode: 'risk-level',
      individual_cell_colors: {},
      individual_cell_texts: {},
      individual_cell_foreground_colors: {},
    };
  }

  private sanitizeConfigDto(dto: HeatmapConfigDto): Record<string, unknown> {
    const allowedKeys = [
      'title',
      'show_issue_count',
      'cell_font_size',
      'matrix_size',
      'status_filter',
      'request_types',
      'color_scheme',
      'custom_colors',
      'use_custom_colors',
      'coloring_mode',
      'individual_cell_colors',
      'individual_cell_texts',
      'individual_cell_foreground_colors',
    ] as const;

    return allowedKeys.reduce<Record<string, unknown>>((acc, key) => {
      if (dto[key] !== undefined) acc[key] = dto[key];
      return acc;
    }, {});
  }

  private async logAudit(
    organizationId: string,
    userId: string,
    action: string,
    changes: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.client.from('audit_logs').insert({
        organization_id: organizationId,
        user_id: userId,
        entity_type: 'heatmap_config',
        entity_id: organizationId,
        action,
        changes,
      });
    } catch {
      // Audit is best-effort and must not break heatmap config mutations.
    }
  }
}
