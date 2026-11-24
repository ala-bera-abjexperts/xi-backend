import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Optional,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AgentOriginService } from '../chat-agent/agent-origin.service';
import { PlansService } from './plans.service';
import { PlansAiService } from './plans-ai.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { CreatePlanItemDto } from './dto/create-plan-item.dto';
import { UpdatePlanItemDto } from './dto/update-plan-item.dto';
import { ReorderPlanItemsDto } from './dto/reorder-plan-items.dto';
import { MovePlanItemDto } from './dto/move-plan-item.dto';
import { CreatePlanStakeholderDto } from './dto/create-plan-stakeholder.dto';
import { UpdatePlanStakeholderDto } from './dto/update-plan-stakeholder.dto';
import { CreatePlanRiskDto } from './dto/create-plan-risk.dto';
import { UpdatePlanRiskDto } from './dto/update-plan-risk.dto';
import { CreatePlanDependencyDto } from './dto/create-plan-dependency.dto';
import { CreatePlanBaselineDto } from './dto/create-plan-baseline.dto';
import { CreatePlanPermissionDto } from './dto/create-plan-permission.dto';
import { UpdatePlanPermissionDto } from './dto/update-plan-permission.dto';
import { GeneratePlanDto } from './dto/generate-plan.dto';
import { ExecutePlanDto } from './dto/execute-plan.dto';
import { SetRagDto } from './dto/set-rag.dto';
import { CreatePlanCommentDto } from './dto/create-plan-comment.dto';
import { UpdatePlanCommentDto } from './dto/update-plan-comment.dto';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';

type PlanListQuery = {
  space_id?: string;
  spaceId?: string;
  organization_id?: string;
  organizationId?: string;
  exclude_plan_ids?: string;
  search?: string;
  plan_type?: string;
  status?: string;
  owner_id?: string;
  is_archived?: boolean | string;
  page?: number | string;
  pageSize?: number | string;
};

@ApiTags('Plans')
@ApiBearerAuth()
@UseGuards(PermissionsGuard)
@Controller('plans')
export class PlansController {
  constructor(
    private readonly service: PlansService,
    private readonly aiService: PlansAiService,
    @Optional() private readonly origins?: AgentOriginService,
  ) {}

  // ---- Plans CRUD ----------------------------------------------------------

  @Get()
  @ApiOperation({ summary: 'List plans in a space' })
  @ApiQuery({
    name: 'space_id',
    required: false,
    example: '53f4d965-0eff-43c1-9f4e-0cd28acbd189',
  })
  @ApiQuery({
    name: 'organization_id',
    required: false,
    example: 'd31e8f83-2f0c-4008-9e59-fbbb53eb646d',
  })
  @ApiQuery({
    name: 'exclude_plan_ids',
    required: false,
    example: '5866a629-c4f9-4e5c-897d-1f99b5974e3b',
  })
  @ApiQuery({ name: 'search', required: false, example: 'Delivery' })
  @ApiQuery({ name: 'plan_type', required: false })
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'owner_id', required: false })
  @ApiQuery({ name: 'is_archived', required: false, type: Boolean })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Space-scoped or organization-scoped plan list.',
  })
  @ApiResponse({
    status: 403,
    description: 'organization_id does not match current user organization.',
  })
  listPlans(
    @CurrentUser() user: RequestUser,
    @Query() query: PlanListQuery = {},
  ) {
    const normalizedSpaceId = this.normalizeAlias(
      'space_id',
      query.space_id,
      query.spaceId,
    );
    const normalizedOrganizationId = this.normalizeAlias(
      'organization_id',
      query.organization_id,
      query.organizationId,
    );
    const isArchived = this.parseOptionalBool('is_archived', query.is_archived);
    const page = this.parseOptionalInt('page', query.page);
    const pageSize = this.parseOptionalInt('pageSize', query.pageSize);

    if (normalizedOrganizationId) {
      // Multi-tenant: allow any org the user is a member of, not just the
      // active one. `user.memberships` is populated by SupabaseAuthGuard.
      const isMember =
        user.memberships?.some(
          (m) => m.organizationId === normalizedOrganizationId,
        ) ?? normalizedOrganizationId === user.organizationId;

      if (!isMember) {
        throw new ForbiddenException('organization_id mismatch');
      }
      return this.service.listOrganizationPlans(
        user.organizationId,
        user.userId,
        {
          search: query.search,
          includeArchived: isArchived === true,
          excludePlanIds: query.exclude_plan_ids
            ? query.exclude_plan_ids
                .split(',')
                .map((id) => id.trim())
                .filter(Boolean)
            : [],
          page,
          pageSize,
        },
      );
    }

    return this.service.listPlans(user.organizationId, user.userId, {
      space_id: normalizedSpaceId,
      search: query.search,
      plan_type: query.plan_type,
      status: query.status,
      owner_id: query.owner_id,
      is_archived: isArchived,
      page,
      pageSize,
    });
  }

  private normalizeAlias(
    canonicalName: string,
    canonicalValue?: string,
    legacyValue?: string,
  ): string | undefined {
    if (canonicalValue && legacyValue && canonicalValue !== legacyValue) {
      throw new BadRequestException(`${canonicalName} mismatch`);
    }
    return canonicalValue ?? legacyValue;
  }

  private parseOptionalBool(
    queryName: string,
    value?: boolean | string,
  ): boolean | undefined {
    if (value === undefined) return undefined;
    if (value === true || value === false) return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new BadRequestException(`${queryName} must be a boolean`);
  }

  private parseOptionalInt(
    queryName: string,
    value?: number | string,
  ): number | undefined {
    if (value === undefined) return undefined;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed)) {
      throw new BadRequestException(`${queryName} must be an integer`);
    }
    return parsed;
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new plan' })
  createPlan(@CurrentUser() user: RequestUser, @Body() dto: CreatePlanDto) {
    return this.service.createPlan(user.organizationId, user.userId, dto);
  }

  // ---- Static sub-paths must precede /:planId -----------------------------

  @Get(':planId')
  @ApiOperation({ summary: 'Get plan details' })
  @ApiParam({ name: 'planId' })
  async getPlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query('withOrigin') withOrigin?: string,
  ) {
    const plan = await this.service.getPlan(
      planId,
      user.organizationId,
      user.userId,
    );
    // XE-T353 1.22: the summary asks for "Drafted by Robert" in the same request. Lists never do.
    if (withOrigin !== 'true' || !this.origins) return plan;
    const origin = await this.origins.forObject(user, 'plan', plan.data);
    return origin
      ? { ...plan, data: { ...plan.data, robert_origin: origin } }
      : plan;
  }

  @Patch(':planId')
  @ApiOperation({ summary: 'Update plan' })
  @ApiParam({ name: 'planId' })
  updatePlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.service.updatePlan(
      planId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':planId')
  @ApiOperation({ summary: 'Delete plan (must be archived first)' })
  @ApiParam({ name: 'planId' })
  deletePlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.deletePlan(planId, user.organizationId, user.userId);
  }

  // ---- Archive ------------------------------------------------------------

  @Post(':planId/archive')
  @ApiOperation({ summary: 'Archive plan' })
  @ApiParam({ name: 'planId' })
  archivePlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.archivePlan(planId, user.organizationId, user.userId);
  }

  @Delete(':planId/archive')
  @ApiOperation({ summary: 'Unarchive plan' })
  @ApiParam({ name: 'planId' })
  unarchivePlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.unarchivePlan(planId, user.organizationId, user.userId);
  }

  @Post(':planId/rag')
  @ApiOperation({ summary: 'Set manual RAG health for a plan' })
  @ApiParam({ name: 'planId', example: '5866a629-c4f9-4e5c-897d-1f99b5974e3b' })
  @ApiBody({
    type: SetRagDto,
    examples: {
      amber: { value: { rag_status: 'amber' } },
      green: { value: { rag_status: 'green' } },
      red: { value: { rag_status: 'red' } },
    },
  })
  @ApiResponse({ status: 201, description: 'Manual RAG override persisted.' })
  @ApiResponse({ status: 400, description: 'Invalid RAG payload.' })
  @ApiResponse({ status: 403, description: 'User cannot edit this plan.' })
  setRag(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: SetRagDto,
  ) {
    return this.service.setRagManually(
      planId,
      user.organizationId,
      user.userId,
      dto.rag_status,
    );
  }

  @Delete(':planId/rag')
  @ApiOperation({ summary: 'Clear manual RAG health for a plan' })
  @ApiParam({ name: 'planId', example: '5866a629-c4f9-4e5c-897d-1f99b5974e3b' })
  @ApiResponse({
    status: 200,
    description: 'Manual RAG override cleared and computed RAG returned.',
  })
  @ApiResponse({ status: 403, description: 'User cannot edit this plan.' })
  clearRag(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.clearManualRag(
      planId,
      user.organizationId,
      user.userId,
    );
  }

  // ---- Items ---------------------------------------------------------------

  @Get(':planId/items')
  @ApiOperation({ summary: 'List all items in a plan' })
  @ApiParam({ name: 'planId' })
  listItems(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.listItems(planId, user.organizationId, user.userId);
  }

  @Post(':planId/items')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add item to plan' })
  @ApiParam({ name: 'planId' })
  addItem(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreatePlanItemDto,
  ) {
    return this.service.addItem(planId, user.organizationId, user.userId, dto);
  }

  @Put(':planId/items/reorder')
  @ApiOperation({ summary: 'Bulk reorder plan items' })
  @ApiParam({ name: 'planId' })
  reorderItems(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: ReorderPlanItemsDto,
  ) {
    return this.service.reorderItems(
      planId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Get(':planId/items/:itemId')
  @ApiOperation({ summary: 'Get a single plan item' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'itemId' })
  getItem(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.getItem(
      planId,
      itemId,
      user.organizationId,
      user.userId,
    );
  }

  @Patch(':planId/items/:itemId')
  @ApiOperation({ summary: 'Update a plan item' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'itemId' })
  updateItem(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: UpdatePlanItemDto,
  ) {
    return this.service.updateItem(
      planId,
      itemId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':planId/items/:itemId')
  @ApiOperation({ summary: 'Remove item from plan' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'itemId' })
  removeItem(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
  ) {
    return this.service.removeItem(
      planId,
      itemId,
      user.organizationId,
      user.userId,
    );
  }

  @Post(':planId/items/:itemId/move')
  @ApiOperation({ summary: 'Move plan item to new parent' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'itemId' })
  moveItem(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Body() dto: MovePlanItemDto,
  ) {
    return this.service.moveItem(
      planId,
      itemId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  // ---- Dependencies --------------------------------------------------------

  @Get(':planId/dependencies')
  @ApiOperation({ summary: 'List Gantt dependencies' })
  @ApiParam({ name: 'planId' })
  listDependencies(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.listDependencies(
      planId,
      user.organizationId,
      user.userId,
    );
  }

  @Post(':planId/dependencies')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a dependency between plan items' })
  @ApiParam({ name: 'planId' })
  addDependency(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreatePlanDependencyDto,
  ) {
    return this.service.addDependency(
      planId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':planId/dependencies/:depId')
  @ApiOperation({ summary: 'Remove a dependency' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'depId' })
  removeDependency(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('depId', ParseUUIDPipe) depId: string,
  ) {
    return this.service.removeDependency(
      planId,
      depId,
      user.organizationId,
      user.userId,
    );
  }

  // ---- Stakeholders --------------------------------------------------------

  @Get(':planId/stakeholders/matrix')
  @ApiOperation({ summary: 'Stakeholder power/interest matrix' })
  @ApiParam({ name: 'planId' })
  getStakeholderMatrix(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.getStakeholderMatrix(
      planId,
      user.organizationId,
      user.userId,
    );
  }

  @Get(':planId/stakeholders')
  @ApiOperation({ summary: 'List plan stakeholders' })
  @ApiParam({ name: 'planId' })
  async listStakeholders(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query('withOrigin') withOrigin?: string,
  ) {
    const list = await this.service.listStakeholders(
      planId,
      user.organizationId,
      user.userId,
    );
    if (withOrigin !== 'true' || !this.origins) return list;
    // Robert 1.23: "Suggested by Robert" on the stakeholders his cards added, one batch.
    const rows = list.data;
    const labels = await this.origins.suggestedLabels(user, user.organizationId, 'plan_stakeholder', rows.map((r) => String(r['id'])));
    return { ...list, data: rows.map((r) => ({ ...r, robert_origin: labels[String(r['id'])] ?? null })) };
  }

  @Post(':planId/stakeholders')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add stakeholder to plan' })
  @ApiParam({ name: 'planId' })
  addStakeholder(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreatePlanStakeholderDto,
  ) {
    return this.service.addStakeholder(
      planId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Patch(':planId/stakeholders/:stakeholderId')
  @ApiOperation({ summary: 'Update a stakeholder' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'stakeholderId' })
  updateStakeholder(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('stakeholderId', ParseUUIDPipe) stakeholderId: string,
    @Body() dto: UpdatePlanStakeholderDto,
  ) {
    return this.service.updateStakeholder(
      planId,
      stakeholderId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':planId/stakeholders/:stakeholderId')
  @ApiOperation({ summary: 'Delete a stakeholder' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'stakeholderId' })
  deleteStakeholder(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('stakeholderId', ParseUUIDPipe) stakeholderId: string,
  ) {
    return this.service.deleteStakeholder(
      planId,
      stakeholderId,
      user.organizationId,
      user.userId,
    );
  }

  // ---- Risks ---------------------------------------------------------------

  @Get(':planId/risks/register')
  @ApiOperation({ summary: 'Risk register (5x5 matrix)' })
  @ApiParam({ name: 'planId' })
  getRiskRegister(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.getRiskRegister(
      planId,
      user.organizationId,
      user.userId,
    );
  }

  @Get(':planId/risks/matrix')
  @ApiOperation({ summary: 'Risk matrix view' })
  @ApiParam({ name: 'planId' })
  getRiskMatrix(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.getRiskMatrix(planId, user.organizationId, user.userId);
  }

  @Get(':planId/risks')
  @ApiOperation({ summary: 'List plan risks' })
  @ApiParam({ name: 'planId' })
  @ApiQuery({ name: 'risk_type', required: false })
  @ApiQuery({
    name: 'is_blocker',
    required: false,
    description:
      'Filter by blocker flag. Pass true to return only blockers, false to exclude them.',
  })
  async listRisks(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query('risk_type') risk_type?: string,
    @Query('is_blocker') is_blocker?: string,
    @Query('withOrigin') withOrigin?: string,
  ) {
    // Tri-state parsing: undefined = no filter, otherwise coerce to boolean.
    // Matches how class-transformer treats string booleans on other endpoints.
    const isBlockerFilter =
      is_blocker === undefined || is_blocker === ''
        ? undefined
        : is_blocker === 'true' || is_blocker === '1';

    const rows = await this.service.listRisks(
      planId,
      user.organizationId,
      user.userId,
      risk_type,
      isBlockerFilter,
    );
    if (withOrigin !== 'true' || !this.origins) return rows;
    // Robert 1.23: "Suggested by Robert" on the risks his cards added, one batch.
    const labels = await this.origins.suggestedLabels(user, user.organizationId, 'plan_risk', rows.map((r) => String(r['id'])));
    return rows.map((r) => ({ ...r, robert_origin: labels[String(r['id'])] ?? null }));
  }

  @Post(':planId/risks')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add risk to plan' })
  @ApiParam({ name: 'planId' })
  addRisk(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreatePlanRiskDto,
  ) {
    return this.service.addRisk(planId, user.organizationId, user.userId, dto);
  }

  @Patch(':planId/risks/:riskId')
  @ApiOperation({ summary: 'Update a risk' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'riskId' })
  updateRisk(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('riskId', ParseUUIDPipe) riskId: string,
    @Body() dto: UpdatePlanRiskDto,
  ) {
    return this.service.updateRisk(
      planId,
      riskId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Delete(':planId/risks/:riskId')
  @ApiOperation({ summary: 'Delete a risk' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'riskId' })
  deleteRisk(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('riskId', ParseUUIDPipe) riskId: string,
  ) {
    return this.service.deleteRisk(
      planId,
      riskId,
      user.organizationId,
      user.userId,
    );
  }

  // ---- Baselines -----------------------------------------------------------

  @Get(':planId/baselines/evm')
  @ApiOperation({ summary: 'Get Earned Value Management metrics' })
  @ApiParam({ name: 'planId' })
  getEvmMetrics(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.getEvmMetrics(planId, user.organizationId, user.userId);
  }

  @Get(':planId/baselines')
  @ApiOperation({ summary: 'List plan baselines' })
  @ApiParam({ name: 'planId' })
  listBaselines(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.listBaselines(planId, user.organizationId, user.userId);
  }

  @Post(':planId/baselines')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a plan baseline snapshot' })
  @ApiParam({ name: 'planId' })
  createBaseline(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreatePlanBaselineDto,
  ) {
    return this.service.createBaseline(
      planId,
      user.organizationId,
      user.userId,
      dto,
    );
  }

  @Post(':planId/baselines/:baselineId/activate')
  @ApiOperation({ summary: 'Activate a baseline' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'baselineId' })
  activateBaseline(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('baselineId', ParseUUIDPipe) baselineId: string,
  ) {
    return this.service.activateBaseline(
      planId,
      baselineId,
      user.organizationId,
      user.userId,
    );
  }

  @Delete(':planId/baselines/:baselineId')
  @ApiOperation({ summary: 'Delete a baseline' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'baselineId' })
  deleteBaseline(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('baselineId', ParseUUIDPipe) baselineId: string,
  ) {
    return this.service.deleteBaseline(
      planId,
      baselineId,
      user.organizationId,
      user.userId,
    );
  }

  // ---- Permissions ---------------------------------------------------------

  @Get(':planId/permissions')
  @ApiOperation({ summary: 'List plan permissions' })
  @ApiParam({ name: 'planId' })
  listPermissions(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service
      .listPermissions(planId, user.organizationId, user.userId)
      .then((data) => ({ data }));
  }

  @Post(':planId/permissions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Grant permission on a plan' })
  @ApiParam({ name: 'planId' })
  grantPermission(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreatePlanPermissionDto,
  ) {
    return this.service
      .grantPermission(planId, user.organizationId, dto, user.userId)
      .then((data) => ({ data, success: true }));
  }

  @Patch(':planId/permissions/:permissionId')
  @ApiOperation({ summary: 'Update plan permission level' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'permissionId' })
  updatePermission(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('permissionId', ParseUUIDPipe) permissionId: string,
    @Body() dto: UpdatePlanPermissionDto,
  ) {
    return this.service
      .updatePermission(
        planId,
        permissionId,
        user.organizationId,
        dto,
        user.userId,
      )
      .then((data) => ({ data, success: true }));
  }

  @Delete(':planId/permissions/:permissionId')
  @ApiOperation({ summary: 'Revoke plan permission' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'permissionId' })
  revokePermission(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('permissionId', ParseUUIDPipe) permissionId: string,
  ) {
    return this.service.revokePermission(
      planId,
      permissionId,
      user.organizationId,
      user.userId,
    );
  }

  // ---- Views ---------------------------------------------------------------

  @Get(':planId/gantt')
  @ApiOperation({ summary: 'Get Gantt view data' })
  @ApiParam({ name: 'planId' })
  async getGanttView(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query('withOrigin') withOrigin?: string,
  ) {
    const view = await this.service.getGanttView(planId, user.organizationId, user.userId);
    if (withOrigin !== 'true' || !this.origins) return view;
    // 1.22.1: the Robert marker per row, in one batch for the plan.
    const tasks = (view as { tasks?: { id: string }[] }).tasks ?? [];
    const marks = await this.origins
      .planMarkers(user.organizationId, planId, tasks.map((t) => t.id))
      .catch(() => new Map<string, 'drafted' | 'added'>());
    return { ...view, tasks: tasks.map((t) => ({ ...t, robert: marks.get(t.id) ?? null })) };
  }

  @Get(':planId/wbs')
  @ApiOperation({ summary: 'Get WBS tree view' })
  @ApiParam({ name: 'planId' })
  async getWbsView(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Query('withOrigin') withOrigin?: string,
  ) {
    const view = await this.service.getWbsView(planId, user.organizationId, user.userId);
    if (withOrigin !== 'true' || !this.origins) return view;
    type Node = { id: string; children?: Node[] } & Record<string, unknown>;
    const ids: string[] = [];
    const walk = (nodes: Node[]) => nodes.forEach((n) => (ids.push(n.id), walk(n.children ?? [])));
    const roots = ((view as { root_items?: Node[] }).root_items ?? []) as Node[];
    walk(roots);
    const marks = await this.origins
      .planMarkers(user.organizationId, planId, ids)
      .catch(() => new Map<string, 'drafted' | 'added'>());
    const mark = (nodes: Node[]): Node[] =>
      nodes.map((n) => ({ ...n, robert: marks.get(n.id) ?? null, ...(n.children && { children: mark(n.children) }) }));
    return { ...view, root_items: mark(roots) };
  }

  @Post(':planId/refresh')
  @ApiOperation({ summary: 'Refresh filter-driven plan' })
  @ApiParam({ name: 'planId' })
  refreshPlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.refreshPlan(planId, user.organizationId, user.userId);
  }

  // ---- AI Generation -------------------------------------------------------

  @Post(':planId/generate/execute')
  @ApiOperation({
    summary: 'Materialize AI-generated plan (execute generation)',
  })
  @ApiParam({ name: 'planId' })
  executePlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: ExecutePlanDto,
  ) {
    return this.aiService.executePlan(
      planId,
      user.organizationId,
      user.userId,
      dto.generation_id,
    );
  }

  @Post(':planId/generate')
  @ApiOperation({ summary: 'Generate AI plan preview from prompt' })
  @ApiParam({ name: 'planId' })
  async generatePlan(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: GeneratePlanDto,
  ) {
    const plan = await this.service.assertCanEditPlan(
      planId,
      user.organizationId,
      user.userId,
    );
    const spaceId = plan['space_id'] as string;
    return this.aiService.generatePlan(
      planId,
      user.organizationId,
      user.userId,
      spaceId,
      dto.prompt,
    );
  }

  // ---- Comments ------------------------------------------------------------

  @Get(':planId/comments')
  @RequirePermissions('can_view_plans')
  @ApiOperation({ summary: 'List comments for a plan' })
  @ApiParam({ name: 'planId' })
  listComments(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.service.getComments(planId, user.organizationId);
  }

  @Post(':planId/comments')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('can_add_comments_plans')
  @ApiOperation({ summary: 'Add a comment to a plan' })
  @ApiParam({ name: 'planId' })
  createComment(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: CreatePlanCommentDto,
  ) {
    return this.service.createComment(
      planId,
      user.organizationId,
      user.userId,
      dto.content,
    );
  }

  @Put(':planId/comments/:commentId')
  @RequirePermissions('can_add_comments_plans')
  @ApiOperation({ summary: 'Update a plan comment (author only)' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'commentId' })
  updateComment(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
    @Body() dto: UpdatePlanCommentDto,
  ) {
    return this.service.updateComment(
      planId,
      commentId,
      user.organizationId,
      user.userId,
      dto.content,
    );
  }

  @Delete(':planId/comments/:commentId')
  @RequirePermissions('can_delete_comments_plans')
  @ApiOperation({ summary: 'Delete a plan comment (author only)' })
  @ApiParam({ name: 'planId' })
  @ApiParam({ name: 'commentId' })
  async deleteComment(
    @CurrentUser() user: RequestUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Param('commentId', ParseUUIDPipe) commentId: string,
  ) {
    await this.service.deleteComment(
      planId,
      commentId,
      user.organizationId,
      user.userId,
    );

    return { success: true, message: 'Comment deleted' };
  }
}
