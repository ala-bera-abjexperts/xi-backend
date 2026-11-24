/**
 * @fileoverview RiskColorService — ported from risk-management-app.
 * Assigns background colors to heatmap cells based on probability × impact
 * using the client's exact ISMS Groovy script conditions.
 * @module src/heatmap/utils/risk-color-service
 */

export class RiskColorService {
  private static readonly CRITICAL = '#F44336';
  private static readonly HIGH = '#FF9800';
  private static readonly MODERATE = '#FFEB3B';
  private static readonly LOW = '#8BC34A';
  private static readonly VERY_LOW = '#4CAF50';

  getCellColor(probability: number, impact: number): string {
    if (
      (probability === 5 && impact > 1) ||
      (probability === 4 && impact > 3) ||
      (probability === 3 && impact > 4)
    ) {
      return RiskColorService.CRITICAL;
    }

    if (
      (probability === 5 && impact === 1) ||
      (probability === 4 && (impact === 2 || impact === 3)) ||
      (probability === 3 && (impact === 3 || impact === 4))
    ) {
      return RiskColorService.HIGH;
    }

    if (
      (probability === 4 && impact === 1) ||
      (probability === 3 && impact === 2) ||
      (probability === 2 && (impact === 3 || impact === 4)) ||
      (probability === 1 && (impact === 4 || impact === 5))
    ) {
      return RiskColorService.MODERATE;
    }

    if (
      (probability === 1 && impact <= 3) ||
      (probability === 2 && impact <= 2) ||
      (probability === 3 && impact === 1)
    ) {
      return RiskColorService.LOW;
    }

    return RiskColorService.VERY_LOW;
  }
}
