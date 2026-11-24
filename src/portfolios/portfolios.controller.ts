import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseBoolPipe,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AddPortfolioPlanDto } from './dto/add-portfolio-plan.dto';
import { CreateLetterDto } from './dto/create-letter.dto';
import { CreatePortfolioDto } from './dto/create-portfolio.dto';
import { RejectLetterDto } from './dto/reject-letter.dto';
import { UpdateLetterDto } from './dto/update-letter.dto';
import { UpdateLetterScheduleDto } from './dto/update-letter-schedule.dto';
import { UpdatePortfolioDto } from './dto/update-portfolio.dto';
import { PortfoliosService } from './portfolios.service';
import type { LetterStatus } from './portfolio-management-letter.repository';
import type { PortfolioStatus } from './portfolio.repository';

@RequireFeature('module_portfolios')
@ApiTags('Portfolios')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('portfolios')
export class PortfoliosController {
  constructor(private readonly service: PortfoliosService) {}

  @Get()
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'List portfolios' })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['draft', 'active', 'on_hold', 'completed'],
  })
  @ApiQuery({ name: 'search', required: false, example: 'Executive' })
  @ApiQuery({
    name: 'include_archived',
    required: false,
    type: Boolean,
    example: false,
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'pageSize', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Portfolio list with pagination metadata.',
  })
  @ApiResponse({
    status: 403,
    description: 'Portfolio module disabled or insufficient permissions.',
  })
  list(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: PortfolioStatus,
    @Query('search') search?: string,
    @Query('include_archived', new ParseBoolPipe({ optional: true }))
    includeArchived?: boolean,
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('pageSize', new ParseIntPipe({ optional: true })) pageSize?: number,
  ) {
    return this.service.list(user.organizationId, {
      status,
      search,
      include_archived: includeArchived,
      page,
      pageSize,
    });
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_create_portfolios')
  @ApiOperation({ summary: 'Create a portfolio' })
  @ApiBody({
    type: CreatePortfolioDto,
    examples: {
      showcase: {
        value: {
          name: 'Executive Assurance Portfolio',
          description:
            'Tracks executive delivery health and management-letter follow-up.',
          status: 'active',
          color: '#2563EB',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Portfolio created.' })
  @ApiResponse({ status: 400, description: 'Invalid portfolio payload.' })
  @ApiResponse({
    status: 403,
    description: 'Portfolio module disabled or insufficient permissions.',
  })
  create(@CurrentUser() user: RequestUser, @Body() dto: CreatePortfolioDto) {
    return this.service.create(user.organizationId, user.userId, dto);
  }

  @Get('by-key/:key')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Get a portfolio by friendly key' })
  @ApiParam({ name: 'key', example: 'PORT-000001' })
  @ApiResponse({ status: 200, description: 'Portfolio row.' })
  @ApiResponse({ status: 404, description: 'Portfolio not found.' })
  getByKey(@CurrentUser() user: RequestUser, @Param('key') key: string) {
    return this.service.getByKey(user.organizationId, key);
  }

  @Get(':portfolioId')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Get a portfolio by ID' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiResponse({ status: 200, description: 'Portfolio row.' })
  @ApiResponse({ status: 404, description: 'Portfolio not found.' })
  getById(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
  ) {
    return this.service.getById(user.organizationId, portfolioId);
  }

  @Patch(':portfolioId')
  @RequirePermissions('can_edit_portfolios')
  @ApiOperation({ summary: 'Update a portfolio' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiBody({
    type: UpdatePortfolioDto,
    examples: {
      metadata: {
        value: {
          description: 'Updated governance summary for executive reporting.',
          status: 'active',
          color: '#0F766E',
          sort_order: 10,
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Portfolio updated.' })
  @ApiResponse({ status: 400, description: 'Invalid update payload.' })
  @ApiResponse({ status: 404, description: 'Portfolio not found.' })
  update(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Body() dto: UpdatePortfolioDto,
  ) {
    return this.service.update(
      user.organizationId,
      user.userId,
      portfolioId,
      dto,
    );
  }

  @Delete(':portfolioId')
  @RequirePermissions('can_delete_portfolios')
  @ApiOperation({ summary: 'Archive or hard-delete a portfolio' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiQuery({ name: 'hard', required: false, type: Boolean, example: false })
  @ApiResponse({
    status: 200,
    description: 'Portfolio archived or hard deleted.',
  })
  delete(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Query('hard', new ParseBoolPipe({ optional: true })) hard?: boolean,
  ) {
    return this.service.delete(
      user.organizationId,
      user.userId,
      portfolioId,
      hard === true,
    );
  }

  @Get(':portfolioId/plans')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'List plans included in a portfolio' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiResponse({
    status: 200,
    description: 'Plans visible to the current user.',
  })
  listPlans(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
  ) {
    return this.service.listPlans(
      user.organizationId,
      user.userId,
      portfolioId,
    );
  }

  @Post(':portfolioId/plans')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_edit_portfolios')
  @ApiOperation({ summary: 'Add a plan to a portfolio' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiBody({
    type: AddPortfolioPlanDto,
    examples: {
      addPlan: { value: { plan_id: '5866a629-c4f9-4e5c-897d-1f99b5974e3b' } },
    },
  })
  @ApiResponse({ status: 201, description: 'Plan added to portfolio.' })
  @ApiResponse({
    status: 409,
    description: 'Plan already exists in portfolio.',
  })
  addPlan(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Body() dto: AddPortfolioPlanDto,
  ) {
    return this.service.addPlan(
      user.organizationId,
      user.userId,
      portfolioId,
      dto,
    );
  }

  @Delete(':portfolioId/plans/:planId')
  @RequirePermissions('can_edit_portfolios')
  @ApiOperation({ summary: 'Remove a plan from a portfolio' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({ name: 'planId', example: '5866a629-c4f9-4e5c-897d-1f99b5974e3b' })
  @ApiResponse({ status: 200, description: 'Plan removed from portfolio.' })
  removePlan(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.removePlan(
      user.organizationId,
      user.userId,
      portfolioId,
      planId,
    );
  }

  @Get(':portfolioId/dashboard')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Get portfolio KPI dashboard data' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiResponse({ status: 200, description: 'Portfolio KPI summary.' })
  getDashboard(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
  ) {
    return this.service.getKpis(user.organizationId, user.userId, portfolioId);
  }

  @Get(':portfolioId/gantt')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({
    summary: 'Get portfolio Gantt tree',
    description:
      'Returns a hierarchical { portfolio, spaces: [{ space, plans: [...] }] } tree. Each plan row includes owner, budget, CPI/SPI, last-letter status, custom field values, and archive flag.',
  })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiResponse({
    status: 200,
    description:
      'Portfolio Gantt tree grouped by space, with archived plans included (flagged via is_archived).',
  })
  getGantt(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
  ) {
    return this.service.getGanttView(
      user.organizationId,
      user.userId,
      portfolioId,
    );
  }

  @Get(':portfolioId/schedule')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Get portfolio management-letter schedule config' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiResponse({ status: 200, description: 'Portfolio letter schedule.' })
  @ApiResponse({
    status: 404,
    description: 'Schedule feature flag is disabled.',
  })
  getSchedule(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
  ) {
    return this.service.getSchedule(user.organizationId, portfolioId);
  }

  @Patch(':portfolioId/schedule')
  @RequirePermissions('can_edit_portfolios')
  @ApiOperation({ summary: 'Set portfolio management-letter schedule config' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiBody({
    type: UpdateLetterScheduleDto,
    examples: {
      monthly: {
        value: {
          enabled: true,
          cadence: 'monthly',
          day_of_period: 5,
          reporting_period_anchor: 'period_end',
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Schedule updated.' })
  setSchedule(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Body() dto: UpdateLetterScheduleDto,
  ) {
    return this.service.setSchedule(
      user.organizationId,
      user.userId,
      portfolioId,
      dto,
    );
  }

  @Get(':portfolioId/letters')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'List management letters for a portfolio' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['draft', 'submitted', 'approved', 'rejected'],
  })
  @ApiResponse({
    status: 200,
    description: 'Management letters visible to the current user.',
  })
  listLetters(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Query('status') status?: LetterStatus,
  ) {
    return this.service.listLetters(
      user.organizationId,
      user.userId,
      portfolioId,
      status,
    );
  }

  @Post(':portfolioId/letters')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_manage_portfolio_letters')
  @ApiOperation({ summary: 'Create a portfolio management letter' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiBody({
    type: CreateLetterDto,
    examples: {
      monthlyReport: {
        value: {
          plan_id: '5866a629-c4f9-4e5c-897d-1f99b5974e3b',
          reporting_period_start: '2026-05-01',
          reporting_period_end: '2026-05-31',
          due_date: '2026-06-07',
          rag_schedule: 'amber',
          rag_budget: 'green',
          rag_quality: 'green',
          key_message:
            'May delivery remains on track overall; supplier handover is the primary watch item.',
        },
      },
    },
  })
  @ApiResponse({
    status: 201,
    description: 'Management letter created and linked task created.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid period, duplicate period, or plan is not in portfolio.',
  })
  createLetter(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Body() dto: CreateLetterDto,
  ) {
    return this.service.createLetter(
      user.organizationId,
      user.userId,
      portfolioId,
      dto,
    );
  }

  @Get(':portfolioId/letters/:letterId')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Get a portfolio management letter' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  getLetter(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
  ) {
    return this.service.getLetter(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
    );
  }

  @Patch(':portfolioId/letters/:letterId')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Update a portfolio management letter' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  @ApiBody({
    type: UpdateLetterDto,
    examples: {
      updateReport: {
        value: {
          key_message:
            'May delivery remains controlled, with supplier handover dates under sponsor review.',
          success_factors: 'Weekly sponsor cadence kept open decisions moving.',
          budget_consumption_percent: 48.25,
          next_steps: [
            'Confirm supplier handover dates',
            'Publish June steering summary',
          ],
          blockers: ['Awaiting final supplier handover confirmation'],
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Management letter updated.' })
  updateLetter(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
    @Body() dto: UpdateLetterDto,
  ) {
    return this.service.updateLetter(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
      dto,
    );
  }

  @Post(':portfolioId/letters/:letterId/recompute-rag')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({
    summary: "Recompute a letter's RAG fields from the plan baseline EVM",
  })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  @ApiResponse({
    status: 201,
    description: 'Letter RAG recomputed from baseline EVM.',
  })
  @ApiResponse({
    status: 400,
    description: 'No active baseline for this plan.',
  })
  recomputeRag(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
  ) {
    return this.service.recomputeRag(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
    );
  }

  @Post(':portfolioId/letters/:letterId/recompute-milestones')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({
    summary:
      "Recompute a letter's achieved milestones from plan milestones completed in the reporting period",
  })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  @ApiResponse({
    status: 201,
    description: 'Letter milestones recomputed from the plan.',
  })
  recomputeMilestones(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
  ) {
    return this.service.recomputeMilestones(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
    );
  }

  @Post(':portfolioId/letters/:letterId/recompute-risks')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({
    summary:
      "Recompute a letter's risks_snapshot from the linked plan's plan_risks (draft letters only)",
  })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  @ApiResponse({
    status: 201,
    description: 'Letter risks snapshot refreshed from the plan.',
  })
  recomputeRisks(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
  ) {
    return this.service.recomputeRisks(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
    );
  }

  @Post(':portfolioId/letters/:letterId/recompute-budget-consumption')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({
    summary:
      "Recompute a letter's budget_consumption_percent from tasks active during the reporting period",
  })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  @ApiResponse({
    status: 201,
    description:
      'Letter budget consumption percent refreshed from the linked plan tasks.',
  })
  recomputeBudgetConsumption(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
  ) {
    return this.service.recomputeBudgetConsumption(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
    );
  }

  @Delete(':portfolioId/letters/:letterId')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Delete a portfolio management letter' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  deleteLetter(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
  ) {
    return this.service.deleteLetter(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
    );
  }

  @Post(':portfolioId/letters/:letterId/submit')
  @RequirePermissions('can_view_portfolios')
  @ApiOperation({ summary: 'Submit a portfolio management letter' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  @ApiResponse({ status: 201, description: 'Letter submitted for review.' })
  submitLetter(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
  ) {
    return this.service.submitLetter(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
    );
  }

  @Post(':portfolioId/letters/:letterId/approve')
  @RequirePermissions('can_manage_portfolio_letters')
  @ApiOperation({ summary: 'Approve a portfolio management letter' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  @ApiResponse({ status: 201, description: 'Letter approved.' })
  approveLetter(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
  ) {
    return this.service.approveLetter(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
    );
  }

  @Post(':portfolioId/letters/:letterId/reject')
  @RequirePermissions('can_manage_portfolio_letters')
  @ApiOperation({ summary: 'Reject a portfolio management letter' })
  @ApiParam({
    name: 'portfolioId',
    example: '4ac500fd-a2b1-4eba-aa35-37e221d8a211',
  })
  @ApiParam({
    name: 'letterId',
    example: '0ec72380-0de4-417f-9453-7814f283f364',
  })
  @ApiBody({
    type: RejectLetterDto,
    examples: {
      reject: {
        value: {
          reason: 'Please add a named mitigation owner before approval.',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Letter rejected back to draft.' })
  rejectLetter(
    @CurrentUser() user: RequestUser,
    @Param('portfolioId', ParseUUIDPipe) portfolioId: string,
    @Param('letterId', ParseUUIDPipe) letterId: string,
    @Body() dto: RejectLetterDto,
  ) {
    return this.service.rejectLetter(
      user.organizationId,
      user.userId,
      portfolioId,
      letterId,
      dto,
    );
  }
}
