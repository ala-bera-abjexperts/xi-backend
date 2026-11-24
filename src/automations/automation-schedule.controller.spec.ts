import { AutomationScheduleController } from './automation-schedule.controller';
import type { IAutomation } from './interfaces/automation.interface';

const mockUser = {
  userId: 'user-1',
  authUserId: 'auth-1',
  email: 'test@example.com',
  organizationId: 'org-1',
};

const mockAutomation: IAutomation = {
  id: 'auto-1',
  organization_id: 'org-1',
  space_id: 'space-1',
  name: 'Test',
  description: null,
  icon: null,
  status: 'published',
  current_version_id: 'ver-1',
  published_version_id: 'ver-1',
  next_run_at: null,
  webhook_token: null,
  webhook_secret_encrypted: null,
  webhook_secret_iv: null,
  webhook_secret_tag: null,
  last_run_at: null,
  last_run_status: null,
  is_archived: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  created_by: 'user-1',
  updated_by: null,
};

function createController() {
  const automationsService = {
    getById: jest.fn().mockResolvedValue(mockAutomation),
  };
  const mockSchedule = {
    id: 'sched-1',
    automation_id: 'auto-1',
    is_active: true,
  };
  const scheduleService = {
    getByAutomation: jest.fn().mockResolvedValue(mockSchedule),
    deactivate: jest.fn().mockResolvedValue(undefined),
    activate: jest.fn().mockResolvedValue(undefined),
  };
  return {
    controller: new AutomationScheduleController(
      automationsService as never,
      scheduleService as never,
    ),
    automationsService,
    scheduleService,
  };
}

describe('AutomationScheduleController', () => {
  describe('pauseSchedule', () => {
    it('calls getById then deactivate and returns schedule_active=false', async () => {
      const { controller, automationsService, scheduleService } =
        createController();
      const result = await controller.pauseSchedule(
        mockUser as never,
        'auto-1',
      );
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(scheduleService.deactivate).toHaveBeenCalledWith('auto-1');
      expect(result).toEqual({
        data: { automation_id: 'auto-1', schedule_active: false },
      });
    });
  });

  describe('resumeSchedule', () => {
    it('calls getById then activate and returns schedule_active=true', async () => {
      const { controller, automationsService, scheduleService } =
        createController();
      const result = await controller.resumeSchedule(
        mockUser as never,
        'auto-1',
      );
      expect(automationsService.getById).toHaveBeenCalledWith(
        'auto-1',
        'org-1',
      );
      expect(scheduleService.activate).toHaveBeenCalledWith('auto-1');
      expect(result).toEqual({
        data: { automation_id: 'auto-1', schedule_active: true },
      });
    });
  });
});
