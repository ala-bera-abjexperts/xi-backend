/**
 * @fileoverview REST controller for the wiki review/approval workflow:
 * space workflow settings and per-page transitions/state.
 * @module src/wiki/wiki-workflow.controller
 */

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireFeature } from '../auth/decorators/require-feature.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireSpacePermission } from '../auth/decorators/require-space-permission.decorator';
import { SpacePermissionsGuard } from '../auth/guards/space-permissions.guard';
import type { RequestUser } from '../auth/interfaces/request-user.interface';
import { WikiWorkflowService } from './wiki-workflow.service';
import { WikiPermissionsService } from './wiki-permissions.service';
import {
  WikiSpaceSettingsDto,
  WikiWorkflowTransitionDto,
} from './dto/wiki-workflow.dto';

@RequireFeature('module_wiki')
@ApiTags('Wiki Workflow')
@ApiBearerAuth()
@UseGuards(SpacePermissionsGuard)
@Controller('spaces/:spaceId/wiki')
export class WikiWorkflowController {
  constructor(
    private readonly workflowService: WikiWorkflowService,
    private readonly permissionsService: WikiPermissionsService,
  ) {}

  /** GET /spaces/:spaceId/wiki/workflow/settings */
  @Get('workflow/settings')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({ summary: 'Get wiki workflow settings for a space' })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 200, description: 'Settings returned' })
  async getSettings(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
  ) {
    return this.workflowService.getSettings(spaceId, user.organizationId);
  }

  /** PUT /spaces/:spaceId/wiki/workflow/settings */
  @Put('workflow/settings')
  @RequireSpacePermission('edit_wiki_pages')
  @ApiOperation({
    summary: 'Update wiki workflow settings (space admin only)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiResponse({ status: 200, description: 'Settings updated' })
  @ApiResponse({ status: 403, description: 'Space admin required' })
  async setSettings(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Body() dto: WikiSpaceSettingsDto,
  ) {
    return this.workflowService.setSettings(spaceId, user, dto);
  }

  /** GET /spaces/:spaceId/wiki/:pageId/workflow */
  @Get(':pageId/workflow')
  @RequireSpacePermission('view_wiki_pages')
  @ApiOperation({
    summary: 'Get workflow state + caller capabilities for a page',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Workflow state returned' })
  async getWorkflowState(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
  ) {
    await this.permissionsService.assertPageAccess(
      pageId,
      user.userId,
      spaceId,
      'can_view',
    );

    return this.workflowService.getWorkflowState(pageId, spaceId, user);
  }

  /** POST /spaces/:spaceId/wiki/:pageId/workflow/transition */
  @Post(':pageId/workflow/transition')
  @RequireSpacePermission('view_wiki_pages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Execute a workflow transition (submit_for_review | approve | reject ' +
      '| withdraw | publish | unpublish)',
  })
  @ApiParam({ name: 'spaceId' })
  @ApiParam({ name: 'pageId' })
  @ApiResponse({ status: 200, description: 'Updated page + capabilities' })
  @ApiResponse({ status: 400, description: 'Invalid transition' })
  @ApiResponse({ status: 403, description: 'Actor not allowed' })
  async transition(
    @CurrentUser() user: RequestUser,
    @Param('spaceId', ParseUUIDPipe) spaceId: string,
    @Param('pageId', ParseUUIDPipe) pageId: string,
    @Body() dto: WikiWorkflowTransitionDto,
  ) {
    // Approvers may lack edit rights — view access is the floor; the service
    // enforces per-action rights (editor/approver/admin/creator).
    await this.permissionsService.assertPageAccess(
      pageId,
      user.userId,
      spaceId,
      'can_view',
    );

    return this.workflowService.transition(pageId, spaceId, user, dto);
  }
}
