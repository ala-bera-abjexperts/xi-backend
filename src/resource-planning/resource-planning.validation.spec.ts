import { BadRequestException } from '@nestjs/common';
import {
  assertEffectiveDateRange,
  validatePlanAllocationShape,
} from './resource-planning.validation';

describe('resource planning validation', () => {
  describe('assertEffectiveDateRange', () => {
    it('accepts open-ended and same-day inclusive periods', () => {
      expect(() => assertEffectiveDateRange('2026-08-14', null)).not.toThrow();
      expect(() =>
        assertEffectiveDateRange('2026-08-14', '2026-08-14'),
      ).not.toThrow();
    });

    it('rejects a period ending before it starts', () => {
      expect(() =>
        assertEffectiveDateRange('2026-08-15', '2026-08-14'),
      ).toThrow(BadRequestException);
    });
  });

  describe('validatePlanAllocationShape', () => {
    it('keeps legacy total-hours allocations compatible', () => {
      expect(() =>
        validatePlanAllocationShape({
          allocation_mode: 'total_hours',
          planned_hours: 24,
        }),
      ).not.toThrow();
    });

    it('requires dates and the selected weekly-hours value', () => {
      expect(() =>
        validatePlanAllocationShape({
          allocation_mode: 'hours_per_week',
          weekly_hours: 8,
        }),
      ).toThrow(BadRequestException);

      expect(() =>
        validatePlanAllocationShape({
          allocation_mode: 'hours_per_week',
          weekly_hours: 8,
          start_date: '2026-08-01',
          end_date: '2026-08-31',
        }),
      ).not.toThrow();
    });

    it('requires percentage mode to stay in the 0..100 range', () => {
      expect(() =>
        validatePlanAllocationShape({
          allocation_mode: 'capacity_percent',
          capacity_percent: 101,
          start_date: '2026-08-01',
          end_date: '2026-08-31',
        }),
      ).toThrow(BadRequestException);
    });
  });
});
