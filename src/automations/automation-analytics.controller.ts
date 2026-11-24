import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiBearerAuth,
} from '@nestjs/swagger';

import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

type RunRow = {
  id: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
};

@RequireFeature('module_automations')
@ApiTags('Automations')
@ApiBearerAuth()
@Controller('automations')
export class AutomationAnalyticsController {
  constructor(private readonly supabaseAdmin: SupabaseAdminService) {}

  @Get(':id/analytics')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({
    summary: 'Get run analytics for an automation (last 30 days)',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({
    name: 'days',
    required: false,
    description: 'Number of days back (default 30)',
  })
  @ApiQuery({
    name: 'startDate',
    required: false,
    description: 'ISO date string start (overrides days)',
  })
  @ApiQuery({
    name: 'endDate',
    required: false,
    description: 'ISO date string end (default today)',
  })
  @ApiResponse({ status: 200, description: 'Analytics payload' })
  async getAnalytics(
    @Param('id') id: string,
    @Query('days') daysStr?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const db = this.supabaseAdmin.getClient();
    const days = daysStr ? parseInt(daysStr, 10) : 30;
    const since = startDate
      ? new Date(startDate).toISOString()
      : new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const until = endDate
      ? new Date(endDate + 'T23:59:59Z').toISOString()
      : new Date().toISOString();

    const { data } = await db
      .from('automation_runs')
      .select('id, status, started_at, finished_at, duration_ms, error_message')
      .eq('automation_id', id)
      .gte('started_at', since)
      .lte('started_at', until)
      .order('started_at', { ascending: true })
      .limit(10000);

    const allRuns = (data ?? []) as RunRow[];
    const total = allRuns.length;
    const succeeded = allRuns.filter((r) => r.status === 'succeeded').length;
    const failed = allRuns.filter((r) => r.status === 'failed').length;
    const cancelled = allRuns.filter((r) => r.status === 'cancelled').length;
    const successRate = total > 0 ? Math.round((succeeded / total) * 100) : 0;

    const durations = allRuns
      .filter((r) => r.duration_ms != null)
      .map((r) => r.duration_ms as number);
    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : null;
    const sorted = [...durations].sort((a, b) => a - b);
    const p50DurationMs =
      sorted.length > 0
        ? (sorted[Math.floor(sorted.length / 2)] ?? null)
        : null;

    const dayMap = new Map<
      string,
      { total: number; succeeded: number; failed: number }
    >();

    for (const run of allRuns) {
      const date = run.started_at.slice(0, 10);
      const bucket = dayMap.get(date) ?? { total: 0, succeeded: 0, failed: 0 };

      bucket.total++;
      if (run.status === 'succeeded') bucket.succeeded++;
      if (run.status === 'failed') bucket.failed++;
      dayMap.set(date, bucket);
    }

    const byDay = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, ...v }));

    const errorMap = new Map<string, number>();

    for (const run of allRuns) {
      if (run.error_message) {
        const key = run.error_message.slice(0, 120);
        errorMap.set(key, (errorMap.get(key) ?? 0) + 1);
      }
    }

    const topErrors = Array.from(errorMap.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([error_message, count]) => ({ error_message, count }));

    return {
      data: {
        summary: {
          total,
          succeeded,
          failed,
          cancelled,
          successRate,
          avgDurationMs,
          p50DurationMs,
        },
        byDay,
        topErrors,
      },
    };
  }
}
