/**
 * @fileoverview HeatmapMatrix — ported from risk-management-app.
 * Builds a probability×impact matrix and populates it with process data.
 * @module src/heatmap/utils/heatmap-matrix
 */

export interface MatrixCell {
  count: number;
  processes: unknown[];
  color: string;
  text: string;
  intensity: number;
  probability: number;
  impact: number;
  foregroundColor?: string;
}

export interface MatrixStats {
  totalProcessed: number;
  excludedCount: number;
  maxCount: number;
  filledCells: number;
  emptyCells: number;
  averageProcessesPerCell: number;
}

export class HeatmapMatrix {
  private size: number;
  private matrix: MatrixCell[][];
  private maxCount = 0;
  private excludedCount = 0;

  constructor(size = 5) {
    this.size = size;
    this.matrix = this.initializeMatrix();
  }

  private initializeMatrix(): MatrixCell[][] {
    return Array(this.size)
      .fill(null)
      .map((_, yIndex) =>
        Array(this.size)
          .fill(null)
          .map((_, xIndex) => ({
            count: 0,
            processes: [],
            color: '#f5f5f5',
            text: '',
            intensity: 0,
            probability: xIndex + 1,
            impact: this.size - yIndex,
          })),
      );
  }

  addProcess(probability: number, impact: number, process: unknown): void {
    const x = probability - 1;
    const y = this.size - impact;

    if (!this.isValidCoordinate(x, y)) return;

    this.matrix[y][x].count++;
    this.matrix[y][x].processes.push(process);
    this.maxCount = Math.max(this.maxCount, this.matrix[y][x].count);
  }

  getCell(probability: number, impact: number): MatrixCell | null {
    const x = probability - 1;
    const y = this.size - impact;
    if (!this.isValidCoordinate(x, y)) return null;
    return this.matrix[y][x];
  }

  setCellProperties(
    probability: number,
    impact: number,
    properties: Partial<MatrixCell>,
  ): void {
    const x = probability - 1;
    const y = this.size - impact;
    if (!this.isValidCoordinate(x, y)) return;
    Object.assign(this.matrix[y][x], properties);
  }

  getMatrix(): MatrixCell[][] {
    return this.matrix;
  }

  getSize(): number {
    return this.size;
  }

  incrementExcluded(): void {
    this.excludedCount++;
  }

  getStatistics(): MatrixStats {
    const nonEmptyCells = this.matrix.flat().filter((c) => c.count > 0);
    const totalProcessed = this.matrix.flat().reduce((t, c) => t + c.count, 0);
    const totalCells = this.size * this.size;

    return {
      totalProcessed,
      excludedCount: this.excludedCount,
      maxCount: this.maxCount,
      filledCells: nonEmptyCells.length,
      emptyCells: totalCells - nonEmptyCells.length,
      averageProcessesPerCell:
        nonEmptyCells.length > 0 ? totalProcessed / nonEmptyCells.length : 0,
    };
  }

  private isValidCoordinate(x: number, y: number): boolean {
    return x >= 0 && x < this.size && y >= 0 && y < this.size;
  }
}
