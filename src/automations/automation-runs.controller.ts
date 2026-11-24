import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  BadRequestException,
  NotFoundException,
  HttpCode,
  HttpStatus,
  UseGuards,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { type Observable, from, switchMap } from 'rxjs';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiBody,
  ApiResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AutomationsService } from './automations.service';
import { AutomationRunsService } from './automation-runs.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { RunActionDto } from './dto/run-action.dto';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

@RequireFeature('module_automations')
@ApiTags('Automation Runs')
@ApiBearerAuth()
@Controller('automations')
export class AutomationRunsController {
  constructor(
    private readonly automationsService: AutomationsService,
    private readonly automationRunsService: AutomationRunsService,
    private readonly auditLogs: AuditLogsService,
    private readonly supabaseAdmin: SupabaseAdminService,
  ) {}

  // Paginated run history for an automation, newest first
  @Get(':id/runs')
  @ApiOperation({
    summary: 'List paginated run history',
    description:
      'Returns runs for the automation ordered by `created_at` descending. ' +
      'Defaults: `page=1`, `limit=20`. Maximum `limit` is 100. ' +
      "If `spaceId` is provided it is validated against the automation's actual space.",
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiQuery({
    name: 'spaceId',
    required: false,
    description: 'Space UUID — validated against the automation if provided',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    type: Number,
    description: 'Page number (default: 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    description: 'Items per page (default: 20, max: 100)',
  })
  @ApiResponse({ status: 200, description: 'Array of automation runs' })
  @ApiResponse({
    status: 400,
    description: 'spaceId does not match this automation',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async listRuns(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const automation = await this.automationsService.getById(
      id,
      user.organizationId,
    );
    if (spaceId && spaceId !== automation.space_id) {
      throw new BadRequestException('spaceId does not match this automation');
    }

    const pageNum = parseInt(page ?? '1', 10);
    const limitNum = Math.min(parseInt(limit ?? '20', 10), 100);
    const offset = (pageNum - 1) * limitNum;

    const data = await this.automationRunsService.listForAutomation(id, {
      limit: limitNum,
      offset,
    });
    return { data };
  }

  // Full run record with all execution steps and their inputs/outputs
  @Get(':id/runs/:runId')
  @ApiOperation({
    summary: 'Get run details with all steps',
    description:
      'Returns the full run record alongside all its execution steps ordered by `step_index`. Each step includes `input`, `output`, `error_message`, and timing fields. ' +
      "If `spaceId` is provided it is validated against the automation's actual space.",
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiParam({ name: 'runId', description: 'Run UUID' })
  @ApiQuery({
    name: 'spaceId',
    required: false,
    description: 'Space UUID — validated against the automation if provided',
  })
  @ApiResponse({
    status: 200,
    description: '`{ run: IAutomationRun, steps: IAutomationRunStep[] }`',
  })
  @ApiResponse({
    status: 400,
    description: 'spaceId does not match this automation',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation or run not found' })
  async getRun(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Query('spaceId') spaceId?: string,
  ) {
    const automation = await this.automationsService.getById(
      id,
      user.organizationId,
    );
    if (spaceId && spaceId !== automation.space_id) {
      throw new BadRequestException('spaceId does not match this automation');
    }

    const [run, steps] = await Promise.all([
      this.automationRunsService.getById(runId, id),
      this.automationRunsService.getSteps(runId),
    ]);

    return { data: { run, steps } };
  }

  @Post(':id/runs/:runId/cancel')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({
    summary: 'Cancel an in-progress run',
    description:
      'Stops a `running` or `queued` run. Sets all `pending` and `running` steps to `cancelled` with an error message indicating who cancelled it. ' +
      'Returns 409 if the run is already in a terminal state (`succeeded`, `failed`, `cancelled`). ' +
      "`spaceId` in the body must match the automation's actual space.",
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiParam({ name: 'runId', description: 'Run UUID' })
  @ApiBody({ type: RunActionDto })
  @ApiResponse({ status: 200, description: '`{ runId }` of the cancelled run' })
  @ApiResponse({
    status: 400,
    description: 'spaceId required or does not match this automation',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  @ApiResponse({ status: 404, description: 'Automation or run not found' })
  @ApiResponse({
    status: 409,
    description: 'Run is already in a terminal state',
  })
  async cancelRun(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() body: RunActionDto,
  ) {
    if (!body.spaceId) throw new BadRequestException('spaceId is required');

    const automation = await this.automationsService.getById(
      id,
      user.organizationId,
    );
    if (body.spaceId !== automation.space_id) {
      throw new BadRequestException('spaceId does not match this automation');
    }

    const data = await this.automationRunsService.cancelRun(
      id,
      runId,
      user.userId,
    );

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation_run',
      runId,
      'update',
      { status: 'cancelled' },
    );

    return { data };
  }

  @Post(':id/runs/:runId/retry')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({
    summary: 'Retry a failed run with the same payload',
    description:
      'Creates a new run using the same `trigger_payload` and `automation_version_id` as the original run. ' +
      'Seeds the first actionable step nodes (non-trigger nodes with no incoming edges) as `pending`. ' +
      'Returns 201 with the new `runId`. ' +
      "`spaceId` in the body must match the automation's actual space.",
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiParam({ name: 'runId', description: 'Original run UUID to retry' })
  @ApiBody({ type: RunActionDto })
  @ApiResponse({
    status: 201,
    description: '`{ runId }` of the newly created retry run',
  })
  @ApiResponse({
    status: 400,
    description: 'spaceId required or does not match this automation',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  @ApiResponse({
    status: 404,
    description: 'Automation or original run not found',
  })
  @ApiResponse({ status: 500, description: 'Failed to create retry run' })
  async retryRun(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Body() body: RunActionDto,
  ) {
    if (!body.spaceId) throw new BadRequestException('spaceId is required');

    const automation = await this.automationsService.getById(
      id,
      user.organizationId,
    );
    if (body.spaceId !== automation.space_id) {
      throw new BadRequestException('spaceId does not match this automation');
    }

    const data = await this.automationRunsService.retryRun(id, runId);

    const newRunId =
      (data as { runId?: string; id?: string })?.runId ??
      (data as { id?: string })?.id ??
      runId;

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation_run',
      newRunId,
      'create',
      { retried_from: runId },
    );

    return { data };
  }

  // SSE stream that pushes run + step updates in real time until the run reaches a terminal state
  @Sse(':id/runs/:runId/stream')
  @ApiOperation({ summary: 'Stream live run status via Server-Sent Events' })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiParam({ name: 'runId', description: 'Run UUID' })
  streamRun(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('runId') runId: string,
  ): Observable<{ data: unknown }> {
    // SECURITY (H1): SSE returns an Observable, so defer the async ownership
    // check into the stream — verify the automation is in the caller's org and
    // the run belongs to it before streaming (a failure errors the stream).
    return from(
      (async () => {
        await this.automationsService.getById(id, user.organizationId);
        await this.automationRunsService.getById(runId, id);
      })(),
    ).pipe(switchMap(() => this.automationRunsService.streamRun(runId)));
  }

  // Reset a failed step to pending so the worker re-executes it; optionally override the input payload
  @Post(':id/runs/:runId/steps/:stepId/replay')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_edit_automations')
  @ApiOperation({
    summary: 'Replay a failed step',
    description:
      'Resets a `failed` step back to `pending` so the worker picks it up on the next cycle. ' +
      'Optionally accepts a custom `payload` to replace the step input. ' +
      'Re-opens the parent run if it is in a terminal state.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiParam({ name: 'runId', description: 'Run UUID' })
  @ApiParam({ name: 'stepId', description: 'Step UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['spaceId'],
      properties: {
        spaceId: { type: 'string', format: 'uuid' },
        payload: {
          description: 'Optional custom input to replace the step input',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Step reset to pending' })
  @ApiResponse({
    status: 400,
    description: 'Step is not in failed state or spaceId mismatch',
  })
  @ApiResponse({ status: 404, description: 'Step not found' })
  async replayStep(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Param('stepId') stepId: string,
    @Body() body: { spaceId: string; payload?: unknown },
  ) {
    if (!body.spaceId) throw new BadRequestException('spaceId is required');

    const db = this.supabaseAdmin.getClient();

    const { data: step } = await db
      .from('automation_run_steps')
      .select(
        'id, run_id, space_id, node_id, node_kind, step_index, input, status, retry_count',
      )
      .eq('id', stepId)
      .eq('run_id', runId)
      .maybeSingle();

    if (!step) throw new NotFoundException('Step not found');
    if ((step as { status: string }).status !== 'failed')
      throw new BadRequestException('Only failed steps can be replayed');

    const s = step as { space_id: string };
    if (body.spaceId !== s.space_id)
      throw new BadRequestException('spaceId does not match this step');

    const updateFields: Record<string, unknown> = {
      status: 'pending',
      error_message: null,
      retry_count: 0,
      lease_until: null,
      worker_id: null,
      finished_at: null,
    };

    if (body.payload !== undefined) updateFields.input = body.payload;

    const { error } = await db
      .from('automation_run_steps')
      .update(updateFields)
      .eq('id', stepId);

    if (error) throw new Error(`Failed to reset step: ${error.message}`);

    await db
      .from('automation_runs')
      .update({
        status: 'running',
        error_message: null,
        error_step_id: null,
        finished_at: null,
      })
      .eq('id', runId)
      .in('status', ['failed', 'succeeded']);

    return { data: { stepId, automationId: id, runId, status: 'pending' } };
  }

  // Resume a step that was paused at a debug breakpoint
  @Post(':id/runs/:runId/steps/:stepId/continue')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_edit_automations')
  @ApiOperation({
    summary: 'Continue a paused step (resume from debug breakpoint)',
    description:
      'Resets a `paused` step back to `pending` so the worker executes it on the next cycle. ' +
      'Also re-opens the parent run if it is not already `running`.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiParam({ name: 'runId', description: 'Run UUID' })
  @ApiParam({ name: 'stepId', description: 'Step UUID' })
  @ApiBody({
    schema: {
      type: 'object',
      required: ['spaceId'],
      properties: { spaceId: { type: 'string', format: 'uuid' } },
    },
  })
  @ApiResponse({
    status: 200,
    description: 'Step resumed — status set to pending',
  })
  @ApiResponse({
    status: 400,
    description: 'Step is not paused or spaceId mismatch',
  })
  @ApiResponse({ status: 404, description: 'Step not found' })
  async continueStep(
    @Param('id') id: string,
    @Param('runId') runId: string,
    @Param('stepId') stepId: string,
    @Body() body: { spaceId: string },
  ) {
    if (!body.spaceId) throw new BadRequestException('spaceId is required');

    const db = this.supabaseAdmin.getClient();

    const { data: step } = await db
      .from('automation_run_steps')
      .select('id, run_id, space_id, status')
      .eq('id', stepId)
      .eq('run_id', runId)
      .maybeSingle();

    if (!step) throw new NotFoundException('Step not found');

    const s = step as { status: string; space_id: string };

    if (s.status !== 'paused')
      throw new BadRequestException('Only paused steps can be continued');
    if (body.spaceId !== s.space_id)
      throw new BadRequestException('spaceId does not match this step');

    await db
      .from('automation_run_steps')
      .update({ status: 'pending', lease_until: null, worker_id: null })
      .eq('id', stepId);

    await db
      .from('automation_runs')
      .update({ status: 'running', error_message: null })
      .eq('id', runId)
      .in('status', ['paused', 'failed', 'succeeded']);

    return { data: { stepId, automationId: id, runId, status: 'pending' } };
  }
}
