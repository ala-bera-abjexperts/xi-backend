import { Controller, Post, Param, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { AutomationsService } from './automations.service';
import { AutomationScheduleService } from './automation-schedule.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

@RequireFeature('module_automations')
@ApiTags('Automation Scheduling')
@ApiBearerAuth()
@Controller('automations')
export class AutomationScheduleController {
  constructor(
    private readonly automationsService: AutomationsService,
    private readonly scheduleService: AutomationScheduleService,
  ) {}

  @Post(':id/schedule/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pause the cron schedule',
    description:
      "Sets `is_active=false` on the automation's cron schedule, silencing future cron-triggered runs. " +
      'The automation itself stays `published` — only the scheduled trigger is muted. ' +
      'Use POST /:id/schedule/resume to reactivate. Has no effect on webhook-triggered automations.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiResponse({
    status: 200,
    description: '`{ automation_id: string, schedule_active: false }`',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async pauseSchedule(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    await this.automationsService.getById(id, user.organizationId);
    const schedule = await this.scheduleService.getByAutomation(id);
    if (!schedule) {
      return {
        data: {
          automation_id: id,
          schedule_active: false,
          message: 'No cron schedule configured for this automation',
        },
      };
    }
    await this.scheduleService.deactivate(id);
    return { data: { automation_id: id, schedule_active: false } };
  }

  @Post(':id/schedule/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume the cron schedule',
    description:
      'Sets `is_active=true` and recomputes `next_run_at` from the current time using the stored `cron_expression` and `timezone`. ' +
      'Safe to call even when `next_run_at` is stale — it always recalculates from now. ' +
      'Returns 404 if no schedule row exists (automation was never published with a cron trigger).',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiResponse({
    status: 200,
    description: '`{ automation_id: string, schedule_active: true }`',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 404,
    description: 'Automation not found or no cron schedule exists',
  })
  async resumeSchedule(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    await this.automationsService.getById(id, user.organizationId);
    const schedule = await this.scheduleService.getByAutomation(id);
    if (!schedule) {
      return {
        data: {
          automation_id: id,
          schedule_active: false,
          message: 'No cron schedule configured for this automation',
        },
      };
    }
    await this.scheduleService.activate(id);
    return { data: { automation_id: id, schedule_active: true } };
  }
}
