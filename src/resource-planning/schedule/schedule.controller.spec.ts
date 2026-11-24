import type { ScheduleService } from './schedule.service';
import { ScheduleController } from './schedule.controller';

describe('ScheduleController', () => {
  it('maps space_id onto ScheduleQuery.spaceId', async () => {
    const scheduleService = {
      getSchedule: jest.fn().mockResolvedValue({ users: [] }),
    } as unknown as jest.Mocked<ScheduleService>;
    const controller = new ScheduleController(scheduleService);
    const space_id = '11111111-1111-4111-8111-111111111111';

    await controller.getSchedule(
      { userId: 'u1', organizationId: 'org-1' } as never,
      { from: '2026-08-03', to: '2026-08-07', space_id },
    );

    expect(scheduleService.getSchedule).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ granularity: 'week', spaceId: space_id }),
      'u1',
    );
  });
});
