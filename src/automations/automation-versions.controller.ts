import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  BadRequestException,
  ForbiddenException,
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
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { AutomationsService } from './automations.service';
import { AutomationVersionsService } from './automation-versions.service';
import { SaveDraftDto } from './dto/save-draft.dto';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';

@RequireFeature('module_automations')
@ApiTags('Automation Versions')
@ApiBearerAuth()
@Controller('automations')
export class AutomationVersionsController {
  constructor(
    private readonly automationsService: AutomationsService,
    private readonly automationVersionsService: AutomationVersionsService,
  ) {}

  @Get(':id/draft')
  @ApiOperation({
    summary: 'Get or create the draft version',
    description:
      'Returns the current draft version of the automation including the full workflow `definition` (nodes + edges). If no draft exists yet, an empty draft is automatically created. Returns 403 if the automation is archived.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiQuery({
    name: 'spaceId',
    required: false,
    description: 'Space UUID — validated against the automation if provided',
  })
  @ApiResponse({
    status: 200,
    description: 'Draft version with full definition',
  })
  @ApiResponse({
    status: 400,
    description: 'spaceId does not match this automation',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({
    status: 403,
    description: 'Automation is archived — draft access not allowed',
  })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async getDraft(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Query('spaceId') spaceId?: string,
  ) {
    const automation = await this.automationsService.getById(
      id,
      user.organizationId,
    );

    if (spaceId && spaceId !== automation.space_id) {
      throw new BadRequestException('spaceId does not match this automation');
    }

    if (automation.is_archived) {
      throw new ForbiddenException(
        'Cannot access draft of an archived automation',
      );
    }

    const data = await this.automationVersionsService.getOrCreateDraft(id, {
      userId: user.userId,
      spaceId: automation.space_id,
    });

    return { data };
  }

  @Put(':id/draft')
  @ApiOperation({
    summary: 'Save the draft version',
    description:
      'Overwrites the draft with the provided `definition`, `trigger_kind`, and/or `trigger_config`. Any field not included falls back to the existing draft value. ' +
      'The `definition` uses ReactFlow format: nodes have `id`, `type` (`trigger` | `action`), `position`, and `data.kind` + `data.config`. ' +
      'Returns 403 if the automation is archived, 404 if no draft exists.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiBody({ type: SaveDraftDto })
  @ApiResponse({ status: 200, description: 'Updated draft version' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 403, description: 'Automation is archived' })
  @ApiResponse({
    status: 404,
    description: 'Automation not found or no draft exists',
  })
  async saveDraft(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: SaveDraftDto,
  ) {
    const automation = await this.automationsService.getById(
      id,
      user.organizationId,
    );

    if (automation.is_archived) {
      throw new ForbiddenException(
        'Cannot edit draft of an archived automation',
      );
    }

    const data = await this.automationVersionsService.saveDraft(id, dto);
    return { data };
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: 'List all versions of an automation',
    description:
      'Returns version summaries ordered by `version_number` descending. Summaries omit the full `definition` and `trigger_config` fields for performance — use GET /:id/versions/:versionId for the complete data.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiResponse({
    status: 200,
    description: 'Array of version summaries (no definition/trigger_config)',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation not found' })
  async listVersions(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
  ) {
    await this.automationsService.getById(id, user.organizationId);
    const data = await this.automationVersionsService.listVersions(id);
    return { data };
  }

  @Get(':id/versions/:versionId')
  @ApiOperation({
    summary: 'Get a specific version with full definition',
    description:
      'Returns the complete version including the full workflow `definition` (all nodes, edges, variables) and `trigger_config`. Use this to inspect historical runs or restore a previous design.',
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiParam({ name: 'versionId', description: 'Version UUID' })
  @ApiResponse({
    status: 200,
    description: 'Full version including definition and trigger_config',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation or version not found' })
  async getVersion(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    await this.automationsService.getById(id, user.organizationId);
    const data = await this.automationVersionsService.getVersionById(
      versionId,
      id,
    );
    return { data };
  }

  @Post(':id/versions/:versionId/restore')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Restore a previous version as a new draft',
    description:
      "Copies the given version's definition and trigger configuration into a new draft version. The new draft gets the next sequential `version_number`. Use this to roll back to a previous workflow design before publishing.",
  })
  @ApiParam({ name: 'id', description: 'Automation UUID' })
  @ApiParam({ name: 'versionId', description: 'Version UUID to restore from' })
  @ApiResponse({
    status: 201,
    description: 'New draft version cloned from the specified version',
  })
  @ApiResponse({ status: 401, description: 'Not authenticated' })
  @ApiResponse({ status: 404, description: 'Automation or version not found' })
  async restoreVersion(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ) {
    await this.automationsService.getById(id, user.organizationId);
    const data = await this.automationVersionsService.cloneDraft(
      versionId,
      { userId: user.userId },
      id,
    );
    return { data };
  }
}
