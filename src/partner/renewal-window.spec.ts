import { renewalWindow } from './partner-sales.service';

describe('renewalWindow', () => {
  it('continues the day after the licence ends, for the same length', () => {
    expect(renewalWindow('2026-01-01', '2026-12-31', '2026-11-20')).toEqual({
      start: '2027-01-01',
      end: '2027-12-31',
    });
  });

  it('starts today when the licence already ended (no back-dating)', () => {
    expect(renewalWindow('2025-01-01', '2025-06-30', '2026-11-20')).toEqual({
      start: '2026-11-20',
      end: '2027-05-19',
    });
  });

  it('keeps the same number of days across a leap year', () => {
    // 2027-03-01..2028-02-29 is 366 days inclusive; so is 2028-03-01..2029-03-01.
    expect(renewalWindow('2027-03-01', '2028-02-29', '2028-01-10')).toEqual({
      start: '2028-03-01',
      end: '2029-03-01',
    });
  });
});
