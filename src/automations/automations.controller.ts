import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
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
import { AutomationCatalogService } from './automation-catalog.service';
import { AutomationTriggerCatalogService } from './automation-trigger-catalog.service';
import { AutomationVersionsService } from './automation-versions.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { SupabaseAdminService } from '../supabase/supabase-admin.service';
import { CreateAutomationDto } from './dto/create-automation.dto';
import { UpdateAutomationDto } from './dto/update-automation.dto';
import { AutomationTemplatesService } from './automation-templates.service';
import { SaveAsTemplateDto } from './dto/save-as-template.dto';
import { UpdateTemplateDto } from './dto/update-template.dto';
import { CreateTemplateDto } from './dto/create-template.dto';
import {
  GetSpaceConfigDto,
  UpdateSpaceConfigDto,
} from './dto/space-config.dto';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

@RequireFeature('module_automations')
@ApiTags('Automations')
@ApiBearerAuth()
@Controller('automations')
export class AutomationsController {
  constructor(
    private readonly automationsService: AutomationsService,
    private readonly automationVersionsService: AutomationVersionsService,
    private readonly catalogService: AutomationCatalogService,
    private readonly triggerCatalogService: AutomationTriggerCatalogService,
    private readonly auditLogs: AuditLogsService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly automationTemplatesService: AutomationTemplatesService,
  ) {}

  @Get()
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({
    summary: 'List automations for a space',
    description:
      'Returns all automations in the given space. Pass `archived=true` to retrieve archived automations only. Requires `can_view_automations` space permission.',
  })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  @ApiQuery({
    name: 'archived',
    required: false,
    type: Boolean,
    description: 'Return archived automations (default: false)',
  })
  @ApiResponse({ status: 200, description: 'Array of automations' })
  @ApiResponse({ status: 400, description: 'spaceId query param required' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  async listAutomations(
    @Query('spaceId') spaceId: string,
    @Query('archived') archived?: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    await this.automationsService.validateSpaceExists(spaceId);
    const data = await this.automationsService.listForSpace(
      spaceId,
      archived === 'true',
    );
    return { data };
  }

  @Post()
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_create_automations')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new automation',
    description:
      'Creates a draft automation in the given space. Requires `can_create_automations` space permission.',
  })
  @ApiBody({ type: CreateAutomationDto })
  @ApiResponse({ status: 201, description: 'Automation created' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  async createAutomation(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateAutomationDto,
  ) {
    const data = await this.automationsService.create(dto, {
      userId: user.userId,
      organizationId: user.organizationId,
    });

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation',
      data.id,
      'create',
      { name: data.name, space_id: data.space_id },
    );

    return { data };
  }

  @Get('actions/catalog')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({
    summary: 'Get available action nodes catalog',
    description:
      'Returns all available automation action node definitions including their config schemas, output schemas, and connection requirements. ' +
      'Used by the automation editor to render the node palette and configuration forms. ' +
      'Requires `can_view_automations` space permission.',
  })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Array of action node definitions' })
  @ApiResponse({ status: 400, description: 'spaceId is required' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  getActionsCatalog(@Query('spaceId') spaceId: string) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    return { data: this.catalogService.getCatalog() };
  }

  @Get('triggers/catalog')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({
    summary: 'Get available trigger nodes catalog',
    description:
      'Returns all available automation trigger node definitions including their config schemas and output schemas. ' +
      'Used by the automation editor to render the trigger node palette and provide {{ trigger.* }} template variable autocomplete. ' +
      'Requires `can_view_automations` space permission.',
  })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  @ApiResponse({
    status: 200,
    description: 'Array of trigger node definitions',
  })
  @ApiResponse({ status: 400, description: 'spaceId is required' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  getTriggersCatalog(@Query('spaceId') spaceId: string) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    return { data: this.triggerCatalogService.getCatalog() };
  }

  @Post('templates')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_create_automations')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a custom automation template directly',
    description:
      'Creates a template from scratch without needing an existing automation draft. Use POST /:id/save-as-template to create from an existing automation.',
  })
  @ApiBody({ type: CreateTemplateDto })
  @ApiResponse({ status: 201, description: 'Created template' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  async createTemplate(
    @Body() dto: CreateTemplateDto,
    @CurrentUser() user: RequestUser,
  ) {
    const data = await this.automationTemplatesService.create({
      space_id: dto.spaceId,
      name: dto.name,
      description: dto.description ?? '',
      category: dto.category ?? 'internal',
      tags: dto.tags ?? [],
      icon: dto.icon ?? 'bx-bolt-circle',
      svg_icon: dto.svg_icon ?? null,
      color: dto.color ?? null,
      trigger_kind: dto.trigger_kind,
      trigger_config: dto.trigger_config ?? {},
      definition: dto.definition ?? { nodes: [], edges: [] },
      is_public: dto.is_public === true,
      created_by: user.userId,
    });
    return { data };
  }

  @Get('templates')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({
    summary: 'List automation templates',
    description:
      'Returns system templates merged with any custom templates saved for the space. Custom templates with the same ID take precedence.',
  })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Array of automation templates' })
  @ApiResponse({ status: 400, description: 'spaceId query param required' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  async getTemplates(@Query('spaceId') spaceId: string) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const data = await this.automationTemplatesService.getTemplates(spaceId);
    return { data };
  }

  @Get('templates/marketplace')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({
    summary: 'List public marketplace templates',
    description:
      "Returns all public templates shared by other spaces. Excludes templates from the caller's own space.",
  })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  @ApiResponse({
    status: 200,
    description: 'Array of public automation templates',
  })
  @ApiResponse({ status: 400, description: 'spaceId query param required' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  async getMarketplaceTemplates(@Query('spaceId') spaceId: string) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const data =
      await this.automationTemplatesService.getMarketplaceTemplates(spaceId);
    return { data };
  }

  @Get('templates/:templateId')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({ summary: 'Get a single automation template by ID' })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Template details' })
  @ApiResponse({ status: 400, description: 'spaceId query param required' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async getTemplate(
    @Param('templateId') templateId: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    const template = await this.automationTemplatesService.getById(
      templateId,
      spaceId,
    );
    if (!template) throw new NotFoundException('Template not found');
    return { data: template };
  }

  @Put('templates/:templateId')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_create_automations')
  @ApiOperation({ summary: 'Update a custom automation template' })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  @ApiBody({ type: UpdateTemplateDto })
  @ApiResponse({ status: 200, description: 'Updated template' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async updateTemplate(
    @Param('templateId') templateId: string,
    @Body() dto: UpdateTemplateDto,
  ) {
    // Destructure spaceId out so it is NOT passed into the DB update payload.
    // whitelist:true strips unknown fields, but spaceId IS a decorated DTO field,
    // so manual destructuring is required to exclude it from the update data object.
    const { spaceId, ...updateInput } = dto;
    const data = await this.automationTemplatesService.update(
      templateId,
      spaceId,
      updateInput,
    );
    return { data };
  }

  @Delete('templates/:templateId')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_create_automations')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a custom automation template' })
  @ApiParam({ name: 'templateId', description: 'Template UUID' })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  @ApiResponse({ status: 204, description: 'Deleted' })
  @ApiResponse({ status: 400, description: 'spaceId query param required' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Insufficient space permissions' })
  @ApiResponse({ status: 404, description: 'Template not found' })
  async deleteTemplate(
    @Param('templateId') templateId: string,
    @Query('spaceId') spaceId: string,
  ) {
    if (!spaceId) throw new BadRequestException('spaceId is required');
    // Pre-check required: Supabase DELETE on a missing row succeeds silently (no error).
    const template = await this.automationTemplatesService.getById(
      templateId,
      spaceId,
    );
    if (!template) throw new NotFoundException('Template not found');
    await this.automationTemplatesService.delete(templateId, spaceId);
  }

  @Get('space-config')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_view_automations')
  @ApiOperation({ summary: 'Get space-level automation config' })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  @ApiResponse({ status: 200, description: 'Space automation config' })
  @ApiResponse({ status: 404, description: 'Space not found' })
  async getSpaceConfig(@Query() dto: GetSpaceConfigDto) {
    const data = await this.automationsService.getSpaceConfig(dto.spaceId);

    return { data };
  }

  @Patch('space-config')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_create_automations')
  @ApiOperation({ summary: 'Update space-level automation config' })
  @ApiQuery({ name: 'spaceId', required: true, description: 'Space UUID' })
  @ApiBody({ type: UpdateSpaceConfigDto })
  @ApiResponse({ status: 200, description: 'Updated space automation config' })
  @ApiResponse({ status: 404, description: 'Space not found' })
  async updateSpaceConfig(@Body() dto: UpdateSpaceConfigDto) {
    const { spaceId, ...input } = dto;
    const data = await this.automationsService.updateSpaceConfig(
      spaceId,
      input,
    );

    return { data };
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get automation by ID',
    description:
      'Returns a single automation including its current status, webhook token, and published version reference.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiQuery({
    name: 'spaceId',
    required: false,
    description: 'Space UUID (optional context)',
  })
  @ApiResponse({ status: 200, description: 'Automation details' })
  @ApiResponse({
    status: 400,
    description: 'spaceId does not match this automation',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async getAutomation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    const data = await this.automationsService.getById(id, user.organizationId);
    if (spaceId && spaceId !== data.space_id) {
      throw new BadRequestException('spaceId does not match this automation');
    }
    return { data };
  }

  @Put(':id')
  @ApiOperation({
    summary: 'Update automation metadata',
    description:
      'Updates name, description, icon, or webhook rate limits. Does not affect the published version or status.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiBody({ type: UpdateAutomationDto })
  @ApiResponse({ status: 200, description: 'Updated automation' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async updateAutomation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: UpdateAutomationDto,
  ) {
    const data = await this.automationsService.update(
      id,
      dto,
      user.userId,
      user.organizationId,
    );

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation',
      id,
      'update',
      dto as unknown as Record<string, unknown>,
    );

    return { data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Archive automation (soft delete)',
    description:
      'Marks the automation as archived (`is_archived=true`). Archived automations are hidden from the default list but can be retrieved with `?archived=true`. Use POST /:id/restore to unarchive.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiResponse({
    status: 204,
    description: 'Automation archived — no body returned',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async archiveAutomation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    await this.automationsService.archive(id, user.organizationId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation',
      id,
      'archive',
      { automation_id: id },
    );
  }

  @Post(':id/publish')
  @ApiOperation({
    summary: 'Publish the current draft version',
    description:
      'Validates the draft definition (must have at least one trigger node), marks it as the published version, and sets automation status to `published`. ' +
      'For `webhook.received` triggers: generates a unique `webhook_token` if not already set. ' +
      'For `schedule.cron` triggers: creates or updates the automation schedule with the computed next run time.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiResponse({
    status: 200,
    description: 'Published automation with updated status and version',
  })
  @ApiResponse({
    status: 400,
    description: 'No nodes, or no trigger node in definition',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation or draft not found' })
  async publishAutomation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    const automation = await this.automationsService.getById(
      id,
      user.organizationId,
    );
    const data = await this.automationVersionsService.publish(id, {
      userId: user.userId,
      spaceId: automation.space_id,
    });

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation',
      id,
      'update',
      { status: 'published', version_id: data.id },
    );

    return { data };
  }

  @Post(':id/pause')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pause a published automation',
    description:
      'Sets automation status to `paused`. Stops all future trigger executions (webhook deliveries and cron schedules). The automation can be resumed with POST /:id/resume.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiResponse({ status: 200, description: 'Automation with status=paused' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async pauseAutomation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    const data = await this.automationsService.pause(id, user.organizationId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation',
      id,
      'update',
      { status: 'paused' },
    );

    return { data };
  }

  @Post(':id/resume')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resume a paused automation',
    description:
      'Sets automation status back to `published`. Only works when the current status is `paused`. Returns 400 if the automation is not currently paused.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiResponse({ status: 200, description: 'Automation with status=published' })
  @ApiResponse({
    status: 400,
    description: 'Automation is not currently paused',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async resumeAutomation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    const automation = await this.automationsService.getById(
      id,
      user.organizationId,
    );
    if (automation.status !== 'paused') {
      throw new BadRequestException('Only paused automations can be resumed');
    }
    const data = await this.automationsService.resume(id, user.organizationId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation',
      id,
      'update',
      { status: 'resumed' },
    );

    return { data };
  }

  @Post(':id/clone')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Clone an automation',
    description:
      'Creates a copy of the automation named `{original name} (copy)`. If the source has a draft version, it is also cloned into the new automation. The clone starts in `draft` status.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID to clone' })
  @ApiResponse({ status: 201, description: 'Cloned automation' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Source automation not found' })
  async cloneAutomation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    const cloned = await this.automationsService.cloneAutomation(id, {
      userId: user.userId,
      organizationId: user.organizationId,
    });

    const sourceDraft = await this.automationVersionsService.getDraft(id);
    if (sourceDraft) {
      await this.automationVersionsService.cloneDraft(sourceDraft.id, {
        userId: user.userId,
      });
    }

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation',
      cloned.id,
      'create',
      { cloned_from: id, name: cloned.name },
    );

    return { data: cloned };
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Restore (unarchive) an automation',
    description:
      'Sets `is_archived=false` on the automation, making it visible in the default list again. The automation status is unchanged.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiResponse({
    status: 200,
    description: '`{ id }` of the restored automation',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async restoreAutomation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    const data = await this.automationsService.restore(id, user.organizationId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation',
      id,
      'restore',
      { is_archived: false },
    );

    return { data };
  }

  @Delete(':id/permanent')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Permanently delete an automation',
    description:
      'Hard-deletes the automation and all related data (versions, runs, steps, subscriptions, schedules). Allowed from any state. This action is irreversible.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiResponse({ status: 204, description: 'Automation permanently deleted' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async permanentDeleteAutomation(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    await this.automationsService.permanentDelete(id, user.organizationId);

    void this.auditLogs.logAction(
      user.organizationId,
      user.userId,
      'automation',
      id,
      'delete',
      { permanent: true },
    );
  }

  // ── Automation permissions ────────────────────────────────────────────────

  @Get(':id/permissions')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('view_automations')
  @ApiOperation({
    summary: 'List users with explicit access to this automation',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  async listPermissions(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    // SECURITY (H1): the SpacePermissionsGuard treats :id as a spaceId (and
    // org-admins bypass), so verify the automation is in the caller's org.
    await this.automationsService.getById(id, user.organizationId);
    const data = await this.automationsService.listPermissions(id);
    return { data };
  }

  @Post(':id/permissions')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_automations')
  @ApiOperation({ summary: 'Grant a user access to this automation' })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  async grantPermission(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() body: { user_id: string; permission_level: string },
  ) {
    await this.automationsService.getById(id, user.organizationId);
    const data = await this.automationsService.grantPermission(id, body);
    return { data };
  }

  @Delete(':id/permissions/:permId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('edit_automations')
  @ApiOperation({ summary: "Revoke a user's access to this automation" })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiParam({ name: 'permId', description: 'Permission row UUID' })
  async revokePermission(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('permId') permId: string,
  ) {
    await this.automationsService.getById(id, user.organizationId);
    await this.automationsService.revokePermission(permId, id);
  }

  @Post(':id/save-as-template')
  @UseGuards(SpacePermissionsGuard)
  @RequireSpacePermission('can_create_automations')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Save the current automation draft as a reusable template',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiBody({ type: SaveAsTemplateDto })
  @ApiResponse({ status: 201, description: 'Created template' })
  @ApiResponse({ status: 400, description: 'No draft version found' })
  async saveAsTemplate(
    @Param('id') id: string,
    @Body() dto: SaveAsTemplateDto,
    @CurrentUser() user: RequestUser,
  ) {
    // SECURITY (H1): verify the automation belongs to the caller's org before
    // reading its draft (the space guard treats :id as a spaceId; admins bypass).
    await this.automationsService.getById(id, user.organizationId);
    const draft = await this.automationVersionsService.getDraft(id);
    if (!draft)
      throw new BadRequestException(
        'No draft version found for this automation',
      );

    const definition = draft.definition ?? { nodes: [], edges: [] };

    const data = await this.automationTemplatesService.create({
      space_id: dto.spaceId,
      name: dto.name ?? draft.trigger_kind,
      description: dto.description ?? '',
      category: dto.category ?? 'internal',
      tags: dto.tags ?? [],
      icon: dto.icon ?? 'bx-bolt-circle',
      svg_icon: dto.svg_icon ?? null,
      color: dto.color ?? null,
      trigger_kind: draft.trigger_kind,
      trigger_config: draft.trigger_config ?? {},
      definition,
      is_public: dto.is_public === true,
      created_by: user.userId,
    });

    return { data };
  }
}
