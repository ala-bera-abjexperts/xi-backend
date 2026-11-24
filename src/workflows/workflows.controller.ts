/**
 * @fileoverview REST controller for `/workflows`.
 * @module src/workflows/workflows.controller
 * @author Rajbha Manek
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { WorkflowsService } from './workflows.service';
import { WorkflowHealthService } from '../workflow-health/workflow-health.service';
import {
  WorkflowsImportExportService,
  type WorkflowExportDoc,
  type ImportResolution,
} from './workflows-import-export.service';
import {
  ImportDryRunDto,
  ImportConfirmDto,
  FromStatusesDto,
} from './dto/import-workflow.dto';
import { CreateWorkflowDto } from './dto/create-workflow.dto';
import { UpdateWorkflowDto } from './dto/update-workflow.dto';
import { DuplicateWorkflowDto } from './dto/duplicate-workflow.dto';
import { SaveCanvasDto } from './dto/save-canvas.dto';
import { PublishWorkflowDto } from './dto/publish-workflow.dto';

@ApiTags('Workflows')
@ApiBearerAuth()
@Controller('workflows')
export class WorkflowsController {
  constructor(
    private readonly service: WorkflowsService,
    private readonly healthService: WorkflowHealthService,
    private readonly importExport: WorkflowsImportExportService,
  ) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_workflows')
  @ApiOperation({ summary: 'List workflows for the org' })
  @ApiQuery({ name: 'spaceId', required: false })
  @ApiQuery({ name: 'isArchived', required: false })
  @ApiQuery({ name: 'isDraft', required: false })
  @ApiResponse({ status: 200, description: 'Workflows returned' })
  async list(
    @CurrentUser() user: RequestUser,
    @Query('spaceId', new ParseUUIDPipe({ optional: true })) spaceId?: string,
    @Query('isArchived') isArchived?: string,
    @Query('isDraft') isDraft?: string,
  ) {
    const data = await this.service.getAll(user.organizationId, {
      spaceId,
      isArchived,
      isDraft,
    });

    return { data, count: data.length };
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_workflows')
  @ApiOperation({ summary: 'Create an empty workflow' })
  @ApiResponse({ status: 201, description: 'Workflow created' })
  async create(
    @CurrentUser() user: RequestUser,
    @Body() dto: CreateWorkflowDto,
  ) {
    return {
      data: await this.service.create(user.organizationId, dto, user.userId),
      success: true,
    };
  }

  // Declared BEFORE `@Get(':id')` so the literal 'trigger-events' path is
  // matched by the router before it can be captured as an `:id` param.
  @Get('trigger-events')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_workflows')
  @ApiOperation({ summary: 'List recent workflow trigger events for the org' })
  @ApiQuery({
    name: 'workflowId',
    required: false,
    description: 'Scope the feed to a single workflow (published workflow id)',
  })
  @ApiResponse({ status: 200, description: 'Trigger events returned' })
  async listTriggerEvents(
    @CurrentUser() user: RequestUser,
    @Query('workflowId', new ParseUUIDPipe({ optional: true }))
    workflowId?: string,
  ) {
    const data = await this.service.listTriggerEvents(
      user.organizationId,
      workflowId,
    );

    return { data };
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_workflows')
  @ApiOperation({ summary: 'Get a workflow with full canvas detail' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Workflow detail returned' })
  async getById(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return { data: await this.service.getDetail(id, user.organizationId) };
  }

  @Put(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({ summary: 'Update workflow name/description/archive state' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Workflow updated' })
  async update(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDto,
  ) {
    return {
      data: await this.service.update(
        id,
        user.organizationId,
        dto,
        user.userId,
      ),
      success: true,
    };
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_delete_workflows')
  @ApiOperation({ summary: 'Archive a workflow (blocked if is_active=true)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Workflow archived' })
  async remove(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.service.archive(id, user.organizationId, user.userId);
    return { success: true, message: 'Workflow archived' };
  }

  @Post(':id/duplicate')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_workflows')
  @ApiOperation({ summary: 'Duplicate a workflow with a new name' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, description: 'Workflow duplicated' })
  async duplicate(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DuplicateWorkflowDto,
  ) {
    return {
      data: await this.service.duplicate(
        id,
        user.organizationId,
        dto.new_name,
        user.userId,
      ),
      success: true,
    };
  }

  @Post(':id/canvas')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({
    summary: 'Save the full canvas atomically via upsert_workflow_canvas',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({
    status: 200,
    description: 'Canvas saved; returns the updated workflow detail',
  })
  @ApiResponse({
    status: 409,
    description: 'Version mismatch or workflow is active/archived',
  })
  async saveCanvas(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SaveCanvasDto,
  ) {
    return {
      data: await this.service.saveCanvas(
        id,
        user.organizationId,
        dto,
        user.userId,
      ),
      success: true,
    };
  }

  @Get(':id/export')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_export_workflow')
  @ApiOperation({ summary: 'Export a workflow as portable, id-free JSON' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, description: 'Workflow export document' })
  async exportWorkflow(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: unknown }> {
    return {
      data: await this.importExport.exportWorkflow(id, user.organizationId),
    };
  }

  @Post('import/dry-run')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_import_workflow')
  @ApiOperation({ summary: 'Dry-run an import; returns the resolution report' })
  async importDryRun(
    @CurrentUser() user: RequestUser,
    @Body() dto: ImportDryRunDto,
  ) {
    return {
      data: await this.importExport.importDryRun(
        dto.doc as unknown as WorkflowExportDoc,
        user.organizationId,
        dto.space_id ?? null,
      ),
    };
  }

  @Post('import')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_import_workflow')
  @ApiOperation({ summary: 'Import a workflow from an export document' })
  @ApiResponse({ status: 409, description: 'Name collision in target scope' })
  async importConfirm(
    @CurrentUser() user: RequestUser,
    @Body() dto: ImportConfirmDto,
  ) {
    return {
      data: await this.importExport.confirmImport(
        dto.doc as unknown as WorkflowExportDoc,
        user.organizationId,
        user.userId,
        dto.resolution as unknown as ImportResolution,
      ),
      success: true,
    };
  }

  @Post('from-statuses')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_create_workflows')
  @ApiOperation({
    summary: 'Build a workflow from a space’s legacy status transitions',
  })
  async createFromStatuses(
    @CurrentUser() user: RequestUser,
    @Body() dto: FromStatusesDto,
  ) {
    return {
      data: await this.importExport.createFromStatuses(
        user.organizationId,
        dto.space_id,
        dto.name,
        user.userId,
      ),
      success: true,
    };
  }

  // ===========================================================================
  // P8 — Draft + publish lifecycle endpoints (D1, D2, D16)
  // ---------------------------------------------------------------------------
  // Permission split (D16):
  //   POST/DELETE :id/draft           → can_edit_workflows
  //   GET/POST :draftId/publish*      → can_publish_workflows
  // ===========================================================================

  @Post(':id/draft')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({
    summary: 'Create a draft of an active workflow (idempotent on 23505).',
  })
  @ApiParam({ name: 'id' })
  @ApiResponse({
    status: 201,
    description:
      'Draft created or — on a one-draft-per-parent race — existing draft returned.',
  })
  @ApiResponse({
    status: 409,
    description:
      'Parent is archived or itself a draft; only active non-draft workflows can be edited as drafts.',
  })
  async createDraft(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return {
      data: await this.service.createDraft(
        id,
        user.organizationId,
        user.userId,
      ),
      success: true,
    };
  }

  @Delete(':draftId/draft')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  @ApiOperation({
    summary: 'Discard a pending workflow draft (FK cascade clears canvas).',
  })
  @ApiParam({ name: 'draftId' })
  @ApiResponse({ status: 200, description: 'Draft discarded.' })
  @ApiResponse({
    status: 400,
    description: 'Target is not a draft workflow.',
  })
  async discardDraft(
    @CurrentUser() user: RequestUser,
    @Param('draftId', ParseUUIDPipe) draftId: string,
  ) {
    await this.service.discardDraft(draftId, user.organizationId, user.userId);
    return { success: true, message: 'Draft discarded' };
  }

  @Get(':draftId/publish-preview')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_publish_workflows')
  @ApiOperation({
    summary:
      'READ-ONLY diff of a draft vs its parent: orphan statuses, affected tasks, suggested mappings.',
  })
  @ApiParam({ name: 'draftId' })
  @ApiResponse({ status: 200, description: 'Preview returned.' })
  async publishPreview(
    @CurrentUser() user: RequestUser,
    @Param('draftId', ParseUUIDPipe) draftId: string,
  ) {
    return {
      data: await this.service.getPublishPreview(draftId, user.organizationId),
    };
  }

  @Post(':draftId/publish')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_publish_workflows')
  @ApiOperation({
    summary:
      'Publish a draft over its parent via publish_workflow_atomic (atomic task migration + canvas swap).',
  })
  @ApiParam({ name: 'draftId' })
  @ApiResponse({
    status: 200,
    description: 'Draft published; returns parent detail + migration counts.',
  })
  @ApiResponse({
    status: 409,
    description:
      'Missing migration mapping for one or more orphan statuses — payload carries orphan_statuses_missing.',
  })
  @ApiResponse({
    status: 404,
    description:
      'Draft already published or discarded by another admin (DRAFT_ALREADY_PUBLISHED).',
  })
  async publish(
    @CurrentUser() user: RequestUser,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @Body() dto: PublishWorkflowDto,
  ) {
    return {
      data: await this.service.publishDraft(
        draftId,
        user.organizationId,
        dto.migration_map ?? {},
        user.userId,
      ),
      success: true,
    };
  }

  // ── Prompt 10 stub ──────────────────────────────────────────────────────
  // The workflow-health/linter module is built in Prompt 10. Until then these
  // return an empty issue list so the editor's LinterPanel renders "no issues"
  // instead of 404-ing against a missing route. Replace with the real
  // workflow-health service in Prompt 10.
  @Get(':id/health')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_view_workflows')
  async health(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: unknown[] }> {
    return {
      data: await this.healthService.getIssues(id, user.organizationId),
    };
  }

  @Post(':id/recheck-health')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('can_edit_workflows')
  async recheckHealth(
    @CurrentUser() user: RequestUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<{ data: unknown[] }> {
    return {
      data: await this.healthService.runLinter(id, user.organizationId),
    };
  }
}
