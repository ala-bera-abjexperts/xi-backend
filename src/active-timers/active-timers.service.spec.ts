import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveTimersService } from './active-timers.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { TimeEntriesService } from '../time-entries/time-entries.service';

describe('ActiveTimersService', () => {
  let service: ActiveTimersService;
  let mockFrom: jest.Mock;
  let mockCreateEntry: jest.Mock;
  let mockLogAction: jest.Mock;

  const USER_ID = 'user-1';
  const TASK_ID = 'task-1';
  const TIMER_ID = 'timer-1';
  const ORG_ID = 'org-1';
  const STARTED_AT = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const mockTimer = {
    id: TIMER_ID,
    user_id: USER_ID,
    task_id: TASK_ID,
    organization_id: ORG_ID,
    started_at: STARTED_AT,
  };

  const mockTimeEntry = {
    id: 'entry-1',
    task_id: TASK_ID,
    user_id: USER_ID,
    organization_id: ORG_ID,
    duration_minutes: 10,
    started_at: STARTED_AT,
    logged_at: new Date().toISOString(),
    note: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  function buildChain(resolved: { data: unknown; error: unknown }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.select = jest.fn().mockImplementation(self);
    chain.eq = jest.fn().mockImplementation(self);
    chain.insert = jest.fn().mockImplementation(self);
    chain.delete = jest.fn().mockImplementation(self);
    chain.single = jest.fn().mockResolvedValue(resolved);
    chain.maybeSingle = jest.fn().mockResolvedValue(resolved);
    chain.then = (onFulfilled: (v: unknown) => unknown) =>
      Promise.resolve(resolved).then(onFulfilled);
    return chain;
  }

  beforeEach(() => {
    mockFrom = jest.fn();
    mockCreateEntry = jest.fn();
    mockLogAction = jest.fn();

    const supa = {
      getClient: () => ({ from: mockFrom }),
    } as unknown as SupabaseAdminService;

    const timeEntriesSvc = {
      createEntry: mockCreateEntry,
    } as unknown as TimeEntriesService;

    service = new ActiveTimersService(supa, timeEntriesSvc, {
      logAction: mockLogAction,
    } as never);
  });

  // ---- getTimer -----------------------------------------------------------

  describe('getTimer', () => {
    it('returns the active timer for a user', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockTimer, error: null }),
      );
      const result = await service.getTimer(USER_ID);
      expect(result).toEqual(mockTimer);
    });

    it('returns null when no timer exists', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      const result = await service.getTimer(USER_ID);
      expect(result).toBeNull();
    });
  });

  // ---- startTimer ---------------------------------------------------------

  describe('startTimer', () => {
    it('creates a new timer when none is running', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: null, error: null })) // no existing timer
        .mockReturnValueOnce(buildChain({ data: { id: TASK_ID }, error: null })) // task scope check
        .mockReturnValueOnce(buildChain({ data: mockTimer, error: null })); // insert

      const result = await service.startTimer(USER_ID, TASK_ID, ORG_ID);
      expect(result.task_id).toBe(TASK_ID);
      expect(result.user_id).toBe(USER_ID);
    });

    it('returns existing timer idempotently for same task', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({ data: mockTimer, error: null }),
      );
      const result = await service.startTimer(USER_ID, TASK_ID, ORG_ID);
      expect(result.id).toBe(TIMER_ID);
    });

    it('throws ConflictException when already running on a different task', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { ...mockTimer, task_id: 'other-task' },
          error: null,
        }),
      );
      await expect(
        service.startTimer(USER_ID, TASK_ID, ORG_ID),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ---- stopTimer ----------------------------------------------------------

  describe('stopTimer', () => {
    it('creates a time entry and deletes the active timer', async () => {
      mockFrom
        .mockReturnValueOnce(buildChain({ data: mockTimer, error: null })) // getTimer
        .mockReturnValueOnce(buildChain({ data: null, error: null })); // delete timer
      mockCreateEntry.mockResolvedValueOnce(mockTimeEntry);

      const result = await service.stopTimer(TIMER_ID, USER_ID, ORG_ID);
      expect(result.task_id).toBe(TASK_ID);
      expect(result.duration_minutes).toBeGreaterThanOrEqual(1);
      expect(mockCreateEntry).toHaveBeenCalledWith(
        expect.objectContaining({ task_id: TASK_ID }),
        USER_ID,
        ORG_ID,
      );
    });

    it('throws NotFoundException when no timer exists', async () => {
      mockFrom.mockReturnValueOnce(buildChain({ data: null, error: null }));
      await expect(
        service.stopTimer(TIMER_ID, USER_ID, ORG_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when timer id does not match', async () => {
      mockFrom.mockReturnValueOnce(
        buildChain({
          data: { ...mockTimer, id: 'different-timer' },
          error: null,
        }),
      );
      await expect(
        service.stopTimer(TIMER_ID, USER_ID, ORG_ID),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
