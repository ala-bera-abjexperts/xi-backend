import {
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AutomationScheduleService } from './automation-schedule.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import type { IAutomationSchedule } from './interfaces/automation.interface';

jest.mock('cron-parser', () => ({
  CronExpressionParser: {
    parse: jest.fn().mockReturnValue({
      next: () => ({ toDate: () => new Date('2026-06-01T00:00:00Z') }),
    }),
  },
}));

const mockSchedule: IAutomationSchedule = {
  id: 'sched-1',
  automation_id: 'auto-1',
  space_id: 'space-1',
  cron_expression: '0 * * * *',
  timezone: 'UTC',
  next_run_at: '2026-06-01T00:00:00Z',
  last_run_at: null,
  is_active: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

describe('AutomationScheduleService', () => {
  let service: AutomationScheduleService;
  let mockFrom: jest.Mock;

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const c: Record<string, jest.Mock> = {};
    const self = () => c;
    ['select', 'eq', 'lte', 'order', 'update', 'upsert'].forEach((m) => {
      c[m] = jest.fn().mockImplementation(self);
    });
    c.single = jest.fn().mockResolvedValue(resolved);
    c.maybeSingle = jest.fn().mockResolvedValue(resolved);
    (
      c as unknown as { then: (r: (v: unknown) => unknown) => Promise<unknown> }
    ).then = (r) => Promise.resolve(resolved).then(r);
    return c;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    const supabaseAdmin = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;
    service = new AutomationScheduleService(supabaseAdmin);
  });

  describe('getByAutomation', () => {
    it('returns schedule for automationId', async () => {
      mockFrom.mockReturnValue(buildChain({ data: mockSchedule, error: null }));
      const result = await service.getByAutomation('auto-1');
      expect(result).toEqual(mockSchedule);
    });

    it('returns null when PGRST116 (no schedule found)', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: 'PGRST116', message: 'not found' },
        }),
      );
      const result = await service.getByAutomation('auto-1');
      expect(result).toBeNull();
    });

    it('throws InternalServerErrorException on other errors', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { code: '500', message: 'DB error' } }),
      );
      await expect(service.getByAutomation('auto-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('upsert', () => {
    it('upserts schedule with onConflict=automation_id and returns it', async () => {
      const chain = buildChain({ data: mockSchedule, error: null });
      mockFrom.mockReturnValue(chain);
      const input = {
        automation_id: 'auto-1',
        space_id: 'space-1',
        cron_expression: '0 * * * *',
        timezone: 'UTC',
        next_run_at: '2026-06-01T00:00:00Z',
        is_active: true,
      };
      const result = await service.upsert(input);
      expect(result).toEqual(mockSchedule);
      expect(chain.upsert).toHaveBeenCalledWith(input, {
        onConflict: 'automation_id',
      });
    });

    it('throws InternalServerErrorException on DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'upsert error' } }),
      );
      await expect(
        service.upsert({
          automation_id: 'auto-1',
          space_id: 's',
          cron_expression: '0 * * * *',
          timezone: 'UTC',
          next_run_at: '',
          is_active: true,
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('deactivate', () => {
    it('sets is_active=false for the automation schedule', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);
      await expect(service.deactivate('auto-1')).resolves.toBeUndefined();
      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({ is_active: false }),
      );
      expect(chain.eq).toHaveBeenCalledWith('automation_id', 'auto-1');
    });

    it('throws InternalServerErrorException on DB error', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: null, error: { message: 'deactivate error' } }),
      );
      await expect(service.deactivate('auto-1')).rejects.toThrow(
        InternalServerErrorException,
      );
    });
  });

  describe('activate', () => {
    it('throws NotFoundException when no schedule exists', async () => {
      mockFrom.mockReturnValue(
        buildChain({
          data: null,
          error: { code: 'PGRST116', message: 'not found' },
        }),
      );
      await expect(service.activate('auto-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('updates is_active=true and computed next_run_at', async () => {
      const getChain = buildChain({ data: mockSchedule, error: null });
      const updateChain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValueOnce(getChain).mockReturnValueOnce(updateChain);
      await expect(service.activate('auto-1')).resolves.toBeUndefined();
      expect(updateChain.update).toHaveBeenCalledWith(
        expect.objectContaining({
          is_active: true,
          next_run_at: '2026-06-01T00:00:00.000Z',
        }),
      );
    });
  });

  describe('findDue', () => {
    it('returns active schedules with past next_run_at', async () => {
      mockFrom.mockReturnValue(
        buildChain({ data: [mockSchedule], error: null }),
      );
      const result = await service.findDue();
      expect(result).toEqual([mockSchedule]);
    });

    it('returns empty array when none due', async () => {
      mockFrom.mockReturnValue(buildChain({ data: [], error: null }));
      const result = await service.findDue();
      expect(result).toEqual([]);
    });
  });

  describe('updateNextRunAt', () => {
    it('updates next_run_at and last_run_at for given id', async () => {
      const chain = buildChain({ data: null, error: null });
      mockFrom.mockReturnValue(chain);
      const nextDate = new Date('2026-07-01T00:00:00Z');
      await expect(
        service.updateNextRunAt('sched-1', nextDate),
      ).resolves.toBeUndefined();
      expect(chain.update).toHaveBeenCalledWith(
        expect.objectContaining({ next_run_at: nextDate.toISOString() }),
      );
      expect(chain.eq).toHaveBeenCalledWith('id', 'sched-1');
    });
  });
});
