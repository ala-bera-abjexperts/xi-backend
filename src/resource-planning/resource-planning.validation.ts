import { BadRequestException } from '@nestjs/common';

export type AllocationMode =
  | 'total_hours'
  | 'hours_per_week'
  | 'capacity_percent';

export interface PlanAllocationShape {
  allocation_mode?: AllocationMode | null;
  planned_hours?: number | null;
  weekly_hours?: number | null;
  capacity_percent?: number | null;
  start_date?: string | null;
  end_date?: string | null;
}

export function assertEffectiveDateRange(
  effectiveFrom: string,
  effectiveTo?: string | null,
): void {
  if (effectiveTo && effectiveTo < effectiveFrom) {
    throw new BadRequestException(
      'The end date must be on or after the start date',
    );
  }
}

export interface DatePairShape {
  start_date?: string | null;
  end_date?: string | null;
}

function assertDatePairShape(shape: DatePairShape): void {
  if (shape.start_date && shape.end_date) {
    assertEffectiveDateRange(shape.start_date, shape.end_date);
  } else if (shape.start_date || shape.end_date) {
    throw new BadRequestException(
      'Both start_date and end_date are required when either is provided',
    );
  }
}

export function validateTaskAllocationDates(allocation: DatePairShape): void {
  assertDatePairShape(allocation);
}

export function validatePlanAllocationShape(
  allocation: PlanAllocationShape,
): void {
  const mode = allocation.allocation_mode ?? 'total_hours';

  assertDatePairShape(allocation);

  if (mode === 'total_hours') {
    return;
  }

  if (!allocation.start_date || !allocation.end_date) {
    throw new BadRequestException(
      'Dated allocation modes require start_date and end_date',
    );
  }

  if (mode === 'hours_per_week') {
    if (allocation.weekly_hours == null) {
      throw new BadRequestException(
        'weekly_hours is required for hours_per_week allocations',
      );
    }
    return;
  }

  if (
    allocation.capacity_percent == null ||
    allocation.capacity_percent < 0 ||
    allocation.capacity_percent > 100
  ) {
    throw new BadRequestException('capacity_percent must be between 0 and 100');
  }
}
