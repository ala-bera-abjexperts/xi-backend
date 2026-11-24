/**
 * @fileoverview CIA Risk Calculator — ported from risk-management-app.
 * Calculates CIA (Confidentiality, Integrity, Availability) values and risk levels
 * from business process vulnerability fields.
 * @module src/heatmap/utils/cia-risk-calculator
 */

export interface CIAValues {
  maxProbability: number;
  maxImpact: number;
  confidentiality: { p: number; i: number };
  integrity: { p: number; i: number };
  availability: { p: number; i: number };
}

/** Minimal process shape required by the calculator */
export interface CIAProcess {
  vuln_c_p: number | null;
  vuln_c_i: number | null;
  vuln_i_p: number | null;
  vuln_i_i: number | null;
  vuln_a_p: number | null;
  vuln_a_i: number | null;
}

export class CIARiskCalculator {
  calculateCIAValues(process: CIAProcess): CIAValues {
    const c_p = this.getFieldValue(process.vuln_c_p);
    const c_i = this.getFieldValue(process.vuln_c_i);
    const i_p = this.getFieldValue(process.vuln_i_p);
    const i_i = this.getFieldValue(process.vuln_i_i);
    const a_p = this.getFieldValue(process.vuln_a_p);
    const a_i = this.getFieldValue(process.vuln_a_i);

    return {
      maxProbability: this.getHighestValue(c_p, i_p, a_p),
      maxImpact: this.getHighestValue(c_i, i_i, a_i),
      confidentiality: { p: c_p, i: c_i },
      integrity: { p: i_p, i: i_i },
      availability: { p: a_p, i: a_i },
    };
  }

  calculateRiskLevel(probability: number, impact: number): string {
    if (
      (probability === 5 && impact > 1) ||
      (probability === 4 && impact > 3) ||
      (probability === 3 && impact > 4)
    ) {
      return 'Kritisch';
    }

    if (
      (probability === 5 && impact === 1) ||
      (probability === 4 && (impact === 2 || impact === 3)) ||
      (probability === 3 && (impact === 3 || impact === 4))
    ) {
      return 'Hoch';
    }

    if (
      (probability === 4 && impact === 1) ||
      (probability === 3 && impact === 2) ||
      (probability === 2 && (impact === 3 || impact === 4)) ||
      (probability === 1 && (impact === 4 || impact === 5))
    ) {
      return 'Mittel';
    }

    if (
      (probability === 1 && impact <= 3) ||
      (probability === 2 && impact <= 2) ||
      (probability === 3 && impact === 1)
    ) {
      return 'Gering';
    }

    return 'Sehr gering';
  }

  private getHighestValue(...values: number[]): number {
    const validValues = values.filter((v) => v > 0);
    return validValues.length > 0 ? Math.max(...validValues) : 0;
  }

  private getFieldValue(field: number | null | undefined): number {
    if (field === null || field === undefined) return 0;
    return Math.round(Number(field)) || 0;
  }
}
