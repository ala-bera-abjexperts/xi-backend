import {
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Optional,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { ImpersonationBlocked } from '../../auth/decorators/impersonation-blocked.decorator';
import { RequireSuperAdmin } from '../../auth/decorators/require-super-admin.decorator';
import { SuperAdminGuard } from '../../auth/guards/super-admin.guard';
import type { RequestUser } from '../../auth/interfaces/request-user.interface';
import { SupabaseAdminService } from '../../supabase/supabase-admin.service';
import { RUNNER_DRAIN_KEY } from '../../test-automation-runner/runner.heartbeat';

/** The shared test runner serves every organisation, so only a platform admin may stop it. */
@ImpersonationBlocked()
@ApiTags('Admin')
@ApiBearerAuth()
@Controller('admin/test-runner')
@RequireSuperAdmin()
@UseGuards(SuperAdminGuard)
export class TestRunnerAdminController {
  private readonly logger = new Logger(TestRunnerAdminController.name);

  constructor(
    private readonly supabaseAdmin: SupabaseAdminService,
    @Optional() private readonly auditLogs?: AuditLogsService,
  ) {}

  @Post('stop')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({
    summary:
      'Asks every running test runner to finish its current tests and stop',
  })
  async stop(
    @CurrentUser() user: RequestUser,
  ): Promise<{ result: 'STOP_REQUESTED' }> {
    // Runners check this time every few seconds; only those started before it stop.
    const { error } = await this.supabaseAdmin
      .getClient()
      .from('cron_run_state')
      .upsert({
        job_name: RUNNER_DRAIN_KEY,
        last_run_at: new Date().toISOString(),
      });

    if (error) {
      throw new ServiceUnavailableException({
        code: 'RUNNER_STOP_FAILED',
        message: 'The stop request could not be saved. Try again.',
      });
    }

    this.logger.log(`Test runner stop asked by user ${user.userId}`);

    // The stop covers every space, so the admin's own id stands in as the entity.
    void this.auditLogs?.logActionForRequest(
      user,
      'test_automation_runner',
      user.userId,
      'update',
      { action: 'stop', scope: 'all_spaces' },
    );

    return { result: 'STOP_REQUESTED' };
  }
}
